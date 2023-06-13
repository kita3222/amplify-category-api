import {
  $TSContext,
  AmplifyCategories,
  AmplifySupportedService,
  JSONUtilities,
  pathManager,
} from '@aws-amplify/amplify-cli-core';
import { printer } from '@aws-amplify/amplify-prompts';
import {
  GraphQLTransform,
  ImportedRDSType,
  MYSQL_DB_TYPE,
  RDSConnectionSecrets,
  StackManager,
} from '@aws-amplify/graphql-transformer-core';
import {
  AppSyncAuthConfiguration,
  DeploymentResources,
  TransformerLogLevel,
} from '@aws-amplify/graphql-transformer-interfaces';
import fs from 'fs-extra';
import { ResourceConstants } from 'graphql-transformer-common';
import {
  DatasourceType,
  sanityCheckProject,
} from 'graphql-transformer-core';
import _ from 'lodash';
import path from 'path';
/* eslint-disable-next-line import/no-cycle */
import { VpcConfig, getHostVpc } from '@aws-amplify/graphql-schema-generator';
import { getAccountConfig, getAppSyncAPIName } from '../provider-utils/awscloudformation/utils/amplify-meta-utils';
import {
  getConnectionSecrets,
  getExistingConnectionSecretNames,
  getSecretsKey,
  testDatabaseConnection,
} from '../provider-utils/awscloudformation/utils/rds-resources/database-resources';
import { AmplifyCLIFeatureFlagAdapter } from './amplify-cli-feature-flag-adapter';
import { isAuthModeUpdated } from './auth-mode-compare';
import { applyOverride } from './override';
import { TransformerFactoryArgs, TransformerProjectOptions } from './transformer-options-types';
import { generateTransformerOptions } from './transformer-options-v2';
import { parseUserDefinedSlots } from './user-defined-slots';
import {
  mergeUserConfigWithTransformOutput, writeDeploymentToDisk,
} from './utils';

const PARAMETERS_FILENAME = 'parameters.json';
const SCHEMA_FILENAME = 'schema.graphql';
const SCHEMA_DIR_NAME = 'schema';
const PROVIDER_NAME = 'awscloudformation';

/**
 * Transform GraphQL Schema
 */
export const transformGraphQLSchemaV2 = async (context: $TSContext, options): Promise<DeploymentResources | undefined> => {
  let resourceName: string;
  const backEndDir = pathManager.getBackendDirPath();
  const flags = context.parameters.options;
  if (flags['no-gql-override']) {
    return undefined;
  }

  let { resourceDir, parameters } = options;
  const { forceCompile } = options;

  // Compilation during the push step
  const { resourcesToBeCreated, resourcesToBeUpdated, allResources } = await context.amplify.getResourceStatus(AmplifyCategories.API);
  let resources = resourcesToBeCreated.concat(resourcesToBeUpdated);

  // When build folder is missing include the API
  // to be compiled without the backend/api/<api-name>/build
  // cloud formation push will fail even if there is no changes in the GraphQL API
  // https://github.com/aws-amplify/amplify-console/issues/10
  const resourceNeedCompile = allResources
    .filter(r => !resources.includes(r))
    .filter(r => {
      const buildDir = path.normalize(path.join(backEndDir, AmplifyCategories.API, r.resourceName, 'build'));
      return !fs.existsSync(buildDir);
    });
  resources = resources.concat(resourceNeedCompile);

  if (forceCompile) {
    resources = resources.concat(allResources);
  }
  resources = resources.filter(resource => resource.service === 'AppSync');

  if (!resourceDir) {
    // There can only be one appsync resource
    if (resources.length > 0) {
      const resource = resources[0];
      if (resource.providerPlugin !== PROVIDER_NAME) {
        return undefined;
      }
      const { category } = resource;
      ({ resourceName } = resource);
      resourceDir = path.normalize(path.join(backEndDir, category, resourceName));
    } else {
      // No appsync resource to update/add
      return undefined;
    }
  }

  const previouslyDeployedBackendDir = options.cloudBackendDirectory;
  if (!previouslyDeployedBackendDir) {
    if (resources.length > 0) {
      const resource = resources[0];
      if (resource.providerPlugin !== PROVIDER_NAME) {
        return undefined;
      }
    }
  }

  const parametersFilePath = path.join(resourceDir, PARAMETERS_FILENAME);

  if (!parameters && fs.existsSync(parametersFilePath)) {
    try {
      parameters = JSONUtilities.readJson(parametersFilePath);

      // OpenSearch Instance type support for x.y.search types
      if (parameters[ResourceConstants.PARAMETERS.OpenSearchInstanceType]) {
        parameters[ResourceConstants.PARAMETERS.OpenSearchInstanceType] = parameters[ResourceConstants.PARAMETERS.OpenSearchInstanceType]
          .replace('.search', '.elasticsearch');
      }
    } catch (e) {
      parameters = {};
    }
  }

  let { authConfig }: { authConfig: AppSyncAuthConfiguration } = options;

  if (_.isEmpty(authConfig) && !_.isEmpty(resources)) {
    authConfig = await context.amplify.invokePluginMethod(
      context,
      AmplifyCategories.API,
      AmplifySupportedService.APPSYNC,
      'getAuthConfig',
      [context, resources[0].resourceName],
    );
    // handle case where auth project is not migrated , if Auth not migrated above function will return empty Object
    if (_.isEmpty(authConfig)) {
      //
      // If we don't have an authConfig from the caller, use it from the
      // already read resources[0], which is an AppSync API.
      //
      if (resources[0].output.securityType) {
        // Convert to multi-auth format if needed.
        authConfig = {
          defaultAuthentication: {
            authenticationType: resources[0].output.securityType,
          },
          additionalAuthenticationProviders: [],
        };
      } else {
        ({ authConfig } = resources[0].output);
      }
    }
  }

  const buildDir = path.normalize(path.join(resourceDir, 'build'));
  const schemaFilePath = path.normalize(path.join(resourceDir, SCHEMA_FILENAME));
  const schemaDirPath = path.normalize(path.join(resourceDir, SCHEMA_DIR_NAME));

  // If it is a dry run, don't create the build folder as it could make a follow-up command
  // to not to trigger a build, hence a corrupt deployment.
  if (!options.dryRun) {
    fs.ensureDirSync(buildDir);
  }

  const buildConfig: TransformerProjectOptions<TransformerFactoryArgs> = await generateTransformerOptions(context, options);
  if (!buildConfig) {
    return undefined;
  }

  const transformerOutput = await buildAPIProject(context, buildConfig);

  printer.success(`GraphQL schema compiled successfully.\n\nEdit your schema at ${schemaFilePath} or \
place .graphql files in a directory at ${schemaDirPath}`);

  if (isAuthModeUpdated(options)) {
    parameters.AuthModeLastUpdated = new Date();
  }
  if (!options.dryRun) {
    JSONUtilities.writeJson(parametersFilePath, parameters);
  }

  return transformerOutput;
};

/**
 * buildAPIProject
 */
const buildAPIProject = async (
  context: $TSContext,
  opts: TransformerProjectOptions<TransformerFactoryArgs>,
): Promise<DeploymentResources|undefined> => {
  const schema = opts.projectConfig.schema.toString();
  // Skip building the project if the schema is blank
  if (!schema) {
    return undefined;
  }

  const builtProject = await _buildProject(context, opts);

  const buildLocation = path.join(opts.projectDirectory, 'build');
  const currentCloudLocation = opts.currentCloudBackendDirectory ? path.join(opts.currentCloudBackendDirectory, 'build') : undefined;

  if (opts.projectDirectory && !opts.dryRun) {
    await writeDeploymentToDisk(context, builtProject, buildLocation, opts.rootStackFileName, opts.buildParameters);
    await sanityCheckProject(
      currentCloudLocation,
      buildLocation,
      opts.rootStackFileName,
      opts.sanityCheckRules.diffRules,
      opts.sanityCheckRules.projectRules,
    );
  }

  // TODO: update local env on api compile
  // await _updateCurrentMeta(opts);

  return builtProject;
};

// eslint-disable-next-line no-underscore-dangle
const _buildProject = async (
  context: $TSContext,
  opts: TransformerProjectOptions<TransformerFactoryArgs>,
): Promise<DeploymentResources> => {
  const userProjectConfig = opts.projectConfig;
  const stackMapping = userProjectConfig.config.StackMapping;
  const userDefinedSlots = {
    ...parseUserDefinedSlots(userProjectConfig.pipelineFunctions),
    ...parseUserDefinedSlots(userProjectConfig.resolvers),
  };
  const { schema, modelToDatasourceMap } = userProjectConfig;
  const datasourceSecretMap = await getDatasourceSecretMap(context);
  const datasourceMapValues: Array<DatasourceType> = modelToDatasourceMap ? Array.from(modelToDatasourceMap.values()) : [];
  let sqlLambdaVpcConfig: VpcConfig | undefined;
  if (datasourceMapValues.some((value) => value.dbType === MYSQL_DB_TYPE && !value.provisionDB)) {
    sqlLambdaVpcConfig = await isSqlLambdaVpcConfigRequired(context, getSecretsKey(), ImportedRDSType.MYSQL);
  }

  const accountConfig = getAccountConfig();

  // Create the transformer instances, we've to make sure we're not reusing them within the same CLI command
  // because the StackMapping feature already builds the project once.
  const transformers = await opts.transformersFactory(opts.transformersFactoryArgs);
  const transform = new GraphQLTransform({
    transformers,
    stackMapping,
    transformConfig: userProjectConfig.config,
    authConfig: opts.authConfig,
    buildParameters: opts.buildParameters,
    stacks: opts.projectConfig.stacks || {},
    featureFlags: new AmplifyCLIFeatureFlagAdapter(),
    sandboxModeEnabled: opts.sandboxModeEnabled,
    userDefinedSlots,
    resolverConfig: opts.resolverConfig,
    overrideConfig: {
      applyOverride: (stackManager: StackManager) => applyOverride(stackManager, path.join(pathManager.getBackendDirPath(), 'api', getAppSyncAPIName())),
      ...opts.overrideConfig,
    },
    sqlLambdaVpcConfig,
    accountConfig,
  });

  try {
    const transformOutput = transform.transform(schema.toString(), {
      modelToDatasourceMap,
      datasourceSecretParameterLocations: datasourceSecretMap,
    });

    return mergeUserConfigWithTransformOutput(userProjectConfig, transformOutput, opts);
  } finally {
    printTransformLogs(transform);
  }
};

const isSqlLambdaVpcConfigRequired = async (
  context: $TSContext,
  secretsKey: string,
  engine: ImportedRDSType,
): Promise<VpcConfig | undefined> => {
  const secrets = await getConnectionSecrets(context, secretsKey, engine);
  const isDBPublic = await testDatabaseConnection(secrets.secrets);
  if (isDBPublic) {
    // No need to deploy the SQL Lambda in VPC if the DB is public
    return undefined;
  }
  const vpcConfig = await getSQLLambdaVpcConfig(context);
  return vpcConfig;
};

const getDatasourceSecretMap = async (context: $TSContext): Promise<Map<string, RDSConnectionSecrets>> => {
  const outputMap = new Map<string, RDSConnectionSecrets>();
  const apiName = getAppSyncAPIName();
  const secretsKey = await getSecretsKey();
  const rdsSecretPaths = await getExistingConnectionSecretNames(context, apiName, secretsKey);
  if (rdsSecretPaths) {
    outputMap.set(MYSQL_DB_TYPE, rdsSecretPaths);
  }
  return outputMap;
};

const printTransformLogs = (transform: GraphQLTransform) => {
  transform.getLogs().forEach((log) => {
    switch (log.level) {
      case TransformerLogLevel.ERROR:
        printer.error(log.message);
        break;
      case TransformerLogLevel.WARN:
        printer.warn(log.message);
        break;
      case TransformerLogLevel.INFO:
        printer.info(log.message);
        break;
      case TransformerLogLevel.DEBUG:
        printer.debug(log.message);
        break;
      default:
        printer.error(log.message);
    }
  });
};

const getSQLLambdaVpcConfig = async (context: $TSContext): Promise<VpcConfig | undefined> => {
  const [secretsKey, engine] = [getSecretsKey(), ImportedRDSType.MYSQL];
  const { secrets } = await getConnectionSecrets(context, secretsKey, engine);
  const region = context.amplify.getProjectMeta().providers.awscloudformation.Region;
  const vpcConfig = getHostVpc(secrets.host, region);
  return vpcConfig;
};
