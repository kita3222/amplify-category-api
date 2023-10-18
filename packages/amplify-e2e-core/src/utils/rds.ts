import {
  RDSClient,
  CreateDBInstanceCommand,
  waitUntilDBInstanceAvailable,
  DeleteDBInstanceCommand,
  CreateDBInstanceCommandInput,
} from '@aws-sdk/client-rds';
import { EC2Client, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand } from '@aws-sdk/client-ec2';
import { knex } from 'knex';
import axios from 'axios';

const DEFAULT_DB_INSTANCE_TYPE = 'db.m5.large';
const DEFAULT_DB_STORAGE = 8;
const DEFAULT_SECURITY_GROUP = 'default';

const IPIFY_URL = 'https://api.ipify.org/';
const AWSCHECKIP_URL = 'https://checkip.amazonaws.com/';

type RDSConfig = {
  identifier: string;
  engine: 'mysql' | 'postgres';
  dbname: string;
  username: string;
  password: string;
  region: string;
  instanceClass?: string;
  storage?: number;
  publiclyAccessible?: boolean;
};

/**
 * Creates a new RDS instance using the given input configuration and returns the details of the created RDS instance.
 * @param config Configuration of the database instance
 * @returns EndPoint address, port and database name of the created RDS instance.
 */
export const createRDSInstance = async (config: RDSConfig): Promise<{ endpoint: string; port: number; dbName: string }> => {
  const client = new RDSClient({ region: config.region });
  const params: CreateDBInstanceCommandInput = {
    /** input parameters */
    DBInstanceClass: config.instanceClass ?? DEFAULT_DB_INSTANCE_TYPE,
    DBInstanceIdentifier: config.identifier,
    AllocatedStorage: config.storage ?? DEFAULT_DB_STORAGE,
    Engine: config.engine,
    DBName: config.dbname,
    MasterUsername: config.username,
    MasterUserPassword: config.password,
    PubliclyAccessible: config.publiclyAccessible ?? true,
  };
  const command = new CreateDBInstanceCommand(params);

  try {
    await client.send(command);
    const availableResponse = await waitUntilDBInstanceAvailable(
      {
        maxWaitTime: 3600,
        maxDelay: 120,
        minDelay: 60,
        client,
      },
      {
        DBInstanceIdentifier: config.identifier,
      },
    );

    if (availableResponse.state !== 'SUCCESS') {
      throw new Error('Error in creating a new RDS instance.');
    }

    const dbInstance = availableResponse.reason.DBInstances[0];
    if (!dbInstance) {
      throw new Error('RDS Instance details are missing.');
    }

    return {
      endpoint: dbInstance.Endpoint.Address as string,
      port: dbInstance.Endpoint.Port as number,
      dbName: dbInstance.DBName as string,
    };
  } catch (error) {
    console.error(error);
    throw new Error('Error in creating RDS instance.');
  }
};

/**
 * Creates a new RDS instance using the given input configuration, runs the given queries and returns the details of the created RDS instance.
 * @param config Configuration of the database instance
 * @param queries Initial queries to be executed
 * @returns EndPoint address, port and database name of the created RDS instance.
 */
export const setupRDSInstanceAndData = async (
  config: RDSConfig,
  queries?: string[],
): Promise<{ endpoint: string; port: number; dbName: string }> => {
  const dbConfig = await createRDSInstance(config);

  if (queries && queries.length > 0) {
    const ipAddresses = await getIpRanges();
    await Promise.all(
      ipAddresses.map((ip) =>
        addRDSPortInboundRule({
          region: config.region,
          port: dbConfig.port,
          cidrIp: ip,
        }),
      ),
    );

    const dbAdapter = new RDSTestDataProvider({
      engine: config.engine,
      host: dbConfig.endpoint,
      port: dbConfig.port,
      username: config.username,
      password: config.password,
      database: config.dbname,
    });

    await dbAdapter.runQuery(queries);
    dbAdapter.cleanup();

    await Promise.all(
      ipAddresses.map((ip) =>
        removeRDSPortInboundRule({
          region: config.region,
          port: dbConfig.port,
          cidrIp: ip,
        }),
      ),
    );
  }

  return dbConfig;
};

/**
 * Deletes the given RDS instance
 * @param identifier RDS Instance identifier to delete
 * @param region RDS Instance region
 */
export const deleteDBInstance = async (identifier: string, region: string): Promise<void> => {
  const client = new RDSClient({ region });
  const params = {
    DBInstanceIdentifier: identifier,
    SkipFinalSnapshot: true,
  };
  const command = new DeleteDBInstanceCommand(params);
  try {
    await client.send(command);

    // TODO: Revisit the below logic for waitUntilDBInstanceDeleted.
    // Right now, when it polls for the status, the database is already deleted and throws 'Resource Not Found'.
    // The deletion has been initiated but it could take few minutes after test completion.

    // await waitUntilDBInstanceDeleted(
    //   {
    //     maxWaitTime: 3600,
    //     maxDelay: 120,
    //     minDelay: 60,
    //     client,
    //   },
    //   {
    //     DBInstanceIdentifier: identifier,
    //   },
    // );
  } catch (error) {
    console.log(error);
    throw new Error('Error in deleting RDS instance.');
  }
};

/**
 * Adds the given inbound rule to the security group.
 * @param config Inbound rule configuration
 */
export const addRDSPortInboundRule = async (config: {
  region: string;
  port: number;
  securityGroup?: string;
  cidrIp: string;
}): Promise<void> => {
  const ec2_client = new EC2Client({
    region: config.region,
  });

  const command = new AuthorizeSecurityGroupIngressCommand({
    GroupName: config.securityGroup ?? DEFAULT_SECURITY_GROUP,
    FromPort: config.port,
    ToPort: config.port,
    IpProtocol: 'TCP',
    CidrIp: config.cidrIp,
  });

  try {
    await ec2_client.send(command);
  } catch (error) {
    // Ignore this error
    // It usually throws error if the security group rule is a duplicate
    // If the rule is not added, we will get an error while establishing connection to the database
  }
};

export const addRDSPortInboundRuleToGroupId = async (config: {
  region: string;
  port: number;
  securityGroupId: string;
  cidrIp: string;
}): Promise<void> => {
  const ec2_client = new EC2Client({
    region: config.region,
  });

  const command = new AuthorizeSecurityGroupIngressCommand({
    GroupId: config.securityGroupId,
    FromPort: config.port,
    ToPort: config.port,
    IpProtocol: 'TCP',
    CidrIp: config.cidrIp,
  });

  try {
    await ec2_client.send(command);
  } catch (error) {
    console.log(error);
    // Ignore this error
    // It usually throws error if the security group rule is a duplicate
    // If the rule is not added, we will get an error while establishing connection to the database
  }
};

/**
 * Removes the given Inbound rule to the security group
 * @param config Inbound rule configuration
 */
export const removeRDSPortInboundRule = async (config: {
  region: string;
  port: number;
  securityGroup?: string;
  cidrIp: string;
}): Promise<void> => {
  const ec2_client = new EC2Client({
    region: config.region,
  });

  const command = new RevokeSecurityGroupIngressCommand({
    GroupName: config.securityGroup ?? DEFAULT_SECURITY_GROUP,
    FromPort: config.port,
    ToPort: config.port,
    IpProtocol: 'TCP',
    CidrIp: config.cidrIp,
  });

  try {
    await ec2_client.send(command);
  } catch (error) {
    // Ignore this error
    // It usually throws error if the security group rule is a duplicate
    // If the rule is not added, we will get an error while establishing connection to the database
  }
};

export class RDSTestDataProvider {
  private dbBuilder: any;

  constructor(
    private config: {
      engine?: string;
      host: string;
      port: number;
      username: string;
      password: string;
      database: string;
    },
  ) {
    this.establishDatabaseConnection();
  }

  private establishDatabaseConnection(): void {
    const databaseConfig = {
      host: this.config.host,
      database: this.config.database,
      port: this.config.port,
      user: this.config.username,
      password: this.config.password,
      ssl: { rejectUnauthorized: false },
    };
    try {
      this.dbBuilder = knex({
        client: this.config.engine === 'postgres' ? 'pg' : 'mysql2',
        connection: databaseConfig,
        pool: {
          min: 0,
          max: 1,
          createTimeoutMillis: 30000,
          acquireTimeoutMillis: 30000,
          idleTimeoutMillis: 30000,
          reapIntervalMillis: 1000,
          createRetryIntervalMillis: 100,
        },
        debug: false,
      });
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  public cleanup(): void {
    this.dbBuilder && this.dbBuilder.destroy();
  }

  public async runQuery(statements: string[]) {
    for (const statement of statements) {
      await this.dbBuilder.raw(statement);
    }
  }
}

export const getResource = (resources: Map<string, any>, resourcePrefix: string, resourceType: string): any => {
  const keys = Array.from(Object.keys(resources)).filter((key) => key.startsWith(resourcePrefix));
  for (const key of keys) {
    const resource = resources[key];
    if (resource.Type === resourceType) {
      return resource;
    }
  }
  return undefined;
};

export const getIpRanges = async (): Promise<string[]> => {
  return Promise.all(
    [IPIFY_URL, AWSCHECKIP_URL].map(async (url) => {
      const response = await axios(url);
      const ipParts = response.data.trim().split('.');
      return `${ipParts[0]}.${ipParts[1]}.0.0/16`;
    }),
  );
};
