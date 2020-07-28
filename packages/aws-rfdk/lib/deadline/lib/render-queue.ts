/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AutoScalingGroup,
  BlockDeviceVolume,
  UpdateType,
} from '@aws-cdk/aws-autoscaling';
import {
  ICertificate,
} from '@aws-cdk/aws-certificatemanager';
import {
  Connections,
  IConnectable,
  InstanceType,
  Port,
  SubnetType,
} from '@aws-cdk/aws-ec2';
import {
  Cluster,
  ContainerImage,
  Ec2TaskDefinition,
  LogDriver,
  PlacementConstraint,
  UlimitName,
} from '@aws-cdk/aws-ecs';
import {
  ApplicationLoadBalancedEc2Service,
} from '@aws-cdk/aws-ecs-patterns';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  CfnTargetGroup,
} from '@aws-cdk/aws-elasticloadbalancingv2';
import {
  IGrantable,
  IPrincipal,
} from '@aws-cdk/aws-iam';
import {
  ILogGroup,
} from '@aws-cdk/aws-logs';
import {
  ISecret,
} from '@aws-cdk/aws-secretsmanager';
import {
  Construct,
  IConstruct,
} from '@aws-cdk/core';

import {
  ECSConnectOptions,
  InstanceConnectOptions,
  IRepository,
  RenderQueueProps,
} from '.';

import {
  ConnectableApplicationEndpoint,
  ImportedAcmCertificate,
  LogGroupFactory,
  X509CertificatePem,
  X509CertificatePkcs12,
} from '../../core';

import {
  RenderQueueConnection,
} from './rq-connection';

/**
 * Interface for Deadline Render Queue.
 */
export interface IRenderQueue extends IConstruct, IConnectable {
  /**
   * The endpoint used to connect to the Render Queue
   */
  readonly endpoint: ConnectableApplicationEndpoint;

  /**
   * Configures an ECS cluster to be able to connect to a RenderQueue
   * @returns An environment mapping that is used to configure the Docker Images
   */
  configureClientECS(params: ECSConnectOptions): { [name: string]: string };

  /**
   * Configure an Instance/Autoscaling group to connect to a RenderQueue
   */
  configureClientInstance(params: InstanceConnectOptions): void;
}

/**
 * Base class for Render Queue providers
 */
abstract class RenderQueueBase extends Construct implements IRenderQueue {
  /**
   * The endpoint that Deadline clients can use to connect to the Render Queue
   */
  public abstract readonly endpoint: ConnectableApplicationEndpoint;

  /**
   * Allows specifying security group connections for the Render Queue.
   */
  public abstract readonly connections: Connections;

  /**
   * Configures an ECS cluster to be able to connect to a RenderQueue
   * @returns An environment mapping that is used to configure the Docker Images
   */
  public abstract configureClientECS(params: ECSConnectOptions): { [name: string]: string };

  /**
   * Configure an Instance/Autoscaling group to connect to a RenderQueue
   */
  public abstract configureClientInstance(params: InstanceConnectOptions): void;
}

/**
 * The RenderQueue construct deploys an Elastic Container Service (ECS) service that serves Deadline's REST HTTP API
 * to Deadline Clients.
 *
 * Most Deadline clients will connect to a Deadline render farm via the the RenderQueue. The API provides Deadline
 * clients access to Deadline's database and repository file-system in a way that is secure, performant, and scalable.
 *
 * @ResourcesDeployed
 * 1) An ECS cluster
 * 2) An EC2 auto-scaling group that provides the EC2 container instances that host the ECS service
 * 3) An ECS service with a task definition that deploys the RCS container
 * 4) A CloudWatch bucket for streaming logs from the RCS container
 * 5) An application load balancer, listener and target group that balance incoming traffic among the RCS containers
 *
 * @ResidualRisk
 * - Grants full read permission to the ASG to CDK's assets bucket.
 * - Care must be taken to secure what can connect to the RenderQueue. The RenderQueue does not authenticate API
 *   requests made against it. Users must take responsibility for limiting access to the RenderQueue endpoint to only
 *   trusted hosts. Those hosts should be governed carefully, as malicious software could use the API to
 *   remotely execute code across the entire render farm.
 */
export class RenderQueue extends RenderQueueBase implements IGrantable {
  /**
   * Container listening ports for each protocol.
   */
  private static readonly RCS_PROTO_PORTS = {
    [ApplicationProtocol.HTTP]: 8080,
    [ApplicationProtocol.HTTPS]: 4433,
  };

  /**
   * Regular expression that validates a hostname (portion in front of the subdomain).
   */
  private static readonly RE_VALID_HOSTNAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

  /**
   * The principal to grant permissions to.
   */
  public readonly grantPrincipal: IPrincipal;

  /**
   * The Amazon ECS cluster that is hosting the fleet of Deadline RCS applications.
   */
  public readonly cluster: Cluster;

  /**
   * @inheritdoc
   */
  public readonly connections: Connections;

  /**
   * @inheritdoc
   */
  public readonly endpoint: ConnectableApplicationEndpoint;

  /**
   * The application load balancer that serves the traffic.
   */
  public readonly loadBalancer: ApplicationLoadBalancer;

  /**
   * The Amazon EC2 Auto Scaling Group within the {@link RenderQueue.cluster}
   * that contains the Deadline RCS's instances.
   */
  public readonly asg: AutoScalingGroup;

  /**
   * The log group where the RCS container will log to
   */
  private readonly logGroup: ILogGroup;

  /**
   * Instance of the Application Load Balanced EC2 service pattern.
   */
  private readonly pattern: ApplicationLoadBalancedEc2Service;

  /**
   * The certificate used by the ALB for external Traffic
   */
  private readonly clientCert?: ICertificate;

  /**
   * The connection object that contains the logic for how clients can connect to the Render Queue.
   */
  private readonly rqConnection: RenderQueueConnection;

  /**
   * The secret containing the cert chain for external connections.
   */
  private readonly certChain?: ISecret;

  constructor(scope: Construct, id: string, props: RenderQueueProps) {
    super(scope, id);

    // The RCS does not currently support horizontal scaling behind a load-balancer, so we limit to at most one instance
    if (props.renderQueueSize && props.renderQueueSize.min !== undefined && props.renderQueueSize.min > 1) {
      throw new Error(`renderQueueSize.min cannot be greater than 1 - got ${props.renderQueueSize.min}`);
    }
    if (props.renderQueueSize && props.renderQueueSize.desired !== undefined && props.renderQueueSize.desired > 1) {
      throw new Error(`renderQueueSize.desired cannot be greater than 1 - got ${props.renderQueueSize.desired}`);
    }

    let externalProtocol: ApplicationProtocol;
    if ( props.trafficEncryption?.externalTLS ) {
      externalProtocol = ApplicationProtocol.HTTPS;

      if ( (props.trafficEncryption.externalTLS.acmCertificate === undefined ) ===
      (props.trafficEncryption.externalTLS.rfdkCertificate === undefined) ) {
        throw new Error('Exactly one of externalTLS.acmCertificate and externalTLS.rfdkCertificate must be provided when using externalTLS.');
      } else if (props.trafficEncryption.externalTLS.rfdkCertificate ) {
        if (props.trafficEncryption.externalTLS.rfdkCertificate.certChain === undefined) {
          throw new Error('Provided rfdkCertificate does not contain a certificate chain.');
        }
        this.clientCert = new ImportedAcmCertificate(this, 'AcmCert', props.trafficEncryption.externalTLS.rfdkCertificate );
        this.certChain = props.trafficEncryption.externalTLS.rfdkCertificate.certChain;
      } else {
        if (props.trafficEncryption.externalTLS.acmCertificateChain === undefined) {
          throw new Error('externalTLS.acmCertificateChain must be provided when using externalTLS.acmCertificate.');
        }
        this.clientCert = props.trafficEncryption.externalTLS.acmCertificate;
        this.certChain = props.trafficEncryption.externalTLS.acmCertificateChain;
      }
    } else {
      externalProtocol = ApplicationProtocol.HTTP;
    }

    const internalProtocol = props.trafficEncryption?.internalProtocol ?? ApplicationProtocol.HTTPS;

    if (externalProtocol === ApplicationProtocol.HTTPS && !props.hostname) {
      throw new Error('A hostname must be provided when the external protocol is HTTPS');
    }

    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
    });

    const minCapacity = props.renderQueueSize?.min ?? 1;
    if (minCapacity < 1) {
      throw new Error(`renderQueueSize.min capacity must be at least 1: got ${minCapacity}`);
    }
    this.asg = this.cluster.addCapacity('RCS Capacity', {
      vpcSubnets: props.vpcSubnets ?? { subnetType: SubnetType.PRIVATE },
      instanceType: props.instanceType ?? new InstanceType('c5.large'),
      minCapacity,
      desiredCapacity: props.renderQueueSize?.desired,
      maxCapacity: 1,
      blockDevices: [{
        deviceName: '/dev/xvda',
        // See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-ami-storage-config.html
        // We want the volume to be encrypted. The default AMI size is 30-GiB.
        volume: BlockDeviceVolume.ebs(30, { encrypted: true }),
      }],
      updateType: UpdateType.ROLLING_UPDATE,
    });

    /**
     * The ECS-optimized AMI that is defaulted to when adding capacity to a cluster does not include the awscli or unzip
     * packages as is the case with the standard Amazon Linux AMI. These are required by RFDK scripts to configure the
     * direct connection on the host container instances.
     */
    this.asg.userData.addCommands(
      'yum install -yq awscli unzip',
    );

    const externalPortNumber = RenderQueue.RCS_PROTO_PORTS[externalProtocol];
    const internalPortNumber = RenderQueue.RCS_PROTO_PORTS[internalProtocol];

    this.logGroup = LogGroupFactory.createOrFetch(this, 'LogGroupWrapper', id, {
      logGroupPrefix: '/renderfarm/',
      ...props.logGroupProps,
    });
    this.logGroup.grantWrite(this.asg);

    const taskDefinition = this.createTaskDefinition({
      image: props.images.remoteConnectionServer,
      portNumber: internalPortNumber,
      protocol: internalProtocol,
      repository: props.repository,
    });

    // The fully-qualified domain name to use for the ALB
    let loadBalancerFQDN: string | undefined;
    if (props.hostname) {
      const label = props.hostname.hostname ?? 'renderqueue';
      if (props.hostname.hostname && !RenderQueue.RE_VALID_HOSTNAME.test(label)) {
        throw new Error(`Invalid RenderQueue hostname: ${label}`);
      }
      loadBalancerFQDN = `${label}.${props.hostname.zone.zoneName}`;
    }

    this.pattern = new ApplicationLoadBalancedEc2Service(this, 'AlbEc2ServicePattern', {
      certificate: this.clientCert,
      cluster: this.cluster,
      desiredCount: props.renderQueueSize?.desired,
      domainZone: props.hostname?.zone,
      domainName: loadBalancerFQDN,
      listenerPort: externalPortNumber,
      publicLoadBalancer: false,
      protocol: externalProtocol,
      taskDefinition,
      // This is required to right-size our host capacity and not have the ECS service block on updates. We set a memory
      // reservation, but no memory limit on the container. This allows the container's memory usage to grow unbounded.
      // We want 1:1 container to container instances to not over-spend, but this comes at the price of down-time during
      // cloudformation updates.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // An explicit dependency is required from the Service to the Client certificate
    // Otherwise cloud formation will try to remove the cert before the ALB using it is disposed.
    if (this.clientCert) {
      this.pattern.node.addDependency(this.clientCert);
    }

    // An explicit dependency is required from the service to the ASG providing its capacity.
    // See: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-dependson.html
    this.pattern.service.node.addDependency(this.asg);

    this.loadBalancer = this.pattern.loadBalancer;

    // Ensure tasks are run on separate container instances
    this.pattern.service.addPlacementConstraints(PlacementConstraint.distinctInstances());

    /**
     * Uses an escape-hatch to set the target group protocol to HTTPS. We cannot configure server certificate
     * validation, but at least traffic is encrypted and terminated at the application layer.
     */
    const listener = this.loadBalancer.node.findChild('PublicListener');
    const targetGroup = listener.node.findChild('ECSGroup') as ApplicationTargetGroup;
    const targetGroupResource = targetGroup.node.defaultChild as CfnTargetGroup;
    targetGroupResource.protocol = ApplicationProtocol[internalProtocol];
    targetGroupResource.port = internalPortNumber;

    this.grantPrincipal = taskDefinition.taskRole;

    this.connections = new Connections({
      defaultPort: Port.tcp(externalPortNumber),
      securityGroups: this.pattern.loadBalancer.connections.securityGroups,
    });

    this.endpoint = new ConnectableApplicationEndpoint({
      address: this.pattern.loadBalancer.loadBalancerDnsName,
      port: externalPortNumber,
      connections: this.connections,
      protocol: externalProtocol,
    });

    if ( externalProtocol === ApplicationProtocol.HTTP ) {
      this.rqConnection = RenderQueueConnection.forHttp({
        endpoint: this.endpoint,
      });
    } else {
      this.rqConnection = RenderQueueConnection.forHttps({
        endpoint: this.endpoint,
        caCert: this.certChain!,
      });
    }

  }

  /**
   * @inheritdoc
   */
  public configureClientECS(param: ECSConnectOptions): { [name: string]: string } {
    return this.rqConnection.configureClientECS(param);
  }

  /**
   * @inheritdoc
   */
  public configureClientInstance(param: InstanceConnectOptions): void {
    this.rqConnection.configureClientInstance(param);
  }

  private createTaskDefinition(props: {
    image: ContainerImage,
    portNumber: number,
    protocol: ApplicationProtocol,
    repository: IRepository,
  }) {
    const { image, portNumber, protocol, repository } = props;

    const taskDefinition = new Ec2TaskDefinition(this, 'RCSTask');

    // Mount the repo filesystem to RenderQueue.HOST_REPO_FS_MOUNT_PATH
    const connection = repository.configureClientECS({
      containerInstances: {
        hosts: [this.asg],
      },
      containers: {
        taskDefinition,
      },
    });

    const environment = connection.containerEnvironment;

    if (protocol === ApplicationProtocol.HTTPS) {
      // Generate a self-signed X509 certificate, private key and passphrase for use by the RCS containers.
      // Note: the Application Load Balancer does not validate the certificate in any way.
      const rcsCertPem = new X509CertificatePem(this, 'TlsCaCertPem', {
        subject: {
          cn: 'renderfarm.local',
        },
      });
      const rcsCertPkcs = new X509CertificatePkcs12(this, 'TlsRcsCertBundle', {
        sourceCertificate: rcsCertPem,
      });
      [rcsCertPem.cert, rcsCertPkcs.cert, rcsCertPkcs.passphrase].forEach(secret => {
        secret.grantRead(taskDefinition.taskRole);
      });
      environment.RCS_TLS_CA_CERT_URI = rcsCertPem.cert.secretArn;
      environment.RCS_TLS_CERT_URI = rcsCertPkcs.cert.secretArn;
      environment.RCS_TLS_CERT_PASSPHRASE_URI = rcsCertPkcs.passphrase.secretArn;
      environment.RCS_TLS_REQUIRE_CLIENT_CERT = 'no';
    }

    const containerDefinition = taskDefinition.addContainer('ContainerDefinition', {
      image,
      memoryReservationMiB: 2048,
      environment,
      logging: LogDriver.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'RCS',
      }),
    });

    containerDefinition.addMountPoints(connection.readWriteMountPoint);

    // Increase ulimits
    containerDefinition.addUlimits(
      {
        name: UlimitName.NOFILE,
        softLimit: 200000,
        hardLimit: 200000,
      }, {
        name: UlimitName.NPROC,
        softLimit: 64000,
        hardLimit: 64000,
      },
    );

    containerDefinition.addPortMappings({
      containerPort: portNumber,
      hostPort: portNumber,
    });

    return taskDefinition;
  }
}
