import { Construct } from 'constructs';
import { executeTransform } from '@aws-amplify/graphql-transformer';
import { NestedStack, Stack } from 'aws-cdk-lib';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { AssetProps } from '@aws-amplify/graphql-transformer-interfaces';
import {
  convertAuthorizationModesToTransformerAuthConfig,
  convertToResolverConfig,
  defaultTranslationBehavior,
  AssetManager,
  getGeneratedResources,
  getGeneratedFunctionSlots,
  CodegenAssets,
  addAmplifyMetadataToStackDescription,
} from './internal';
import type { AmplifyGraphqlApiResources, AmplifyGraphqlApiProps, FunctionSlot, IBackendOutputStorageStrategy } from './types';
import { parseUserDefinedSlots, validateFunctionSlots, separateSlots } from './internal/user-defined-slots';

// These will be imported from CLI in future
import { GraphqlOutput, GraphqlOutputKey, AwsAppsyncAuthenticationType, StackMetadataBackendOutputStorageStrategy } from './graphql-output';

/**
 * L3 Construct which invokes the Amplify Transformer Pattern over an input Graphql Schema.
 *
 * This can be used to quickly define appsync apis which support full CRUD+List and Subscriptions, relationships,
 * auth, search over data, the ability to inject custom business logic and query/mutation operations, and connect to ML services.
 *
 * For more information, refer to the docs links below:
 * Data Modeling - https://docs.amplify.aws/cli/graphql/data-modeling/
 * Authorization - https://docs.amplify.aws/cli/graphql/authorization-rules/
 * Custom Business Logic - https://docs.amplify.aws/cli/graphql/custom-business-logic/
 * Search - https://docs.amplify.aws/cli/graphql/search-and-result-aggregations/
 * ML Services - https://docs.amplify.aws/cli/graphql/connect-to-machine-learning-services/
 *
 * For a full reference of the supported custom graphql directives - https://docs.amplify.aws/cli/graphql/directives-reference/
 *
 * The output of this construct is a mapping of L1 resources generated by the transformer, which generally follow the access pattern
 *
 * ```typescript
 *   const api = new AmplifyGraphQlApi(this, 'api', { <params> });
 *   api.resources.api.xrayEnabled = true;
 *   Object.values(api.resources.tables).forEach(table => table.pointInTimeRecoverySpecification = { pointInTimeRecoveryEnabled: false });
 * ```
 * `resources.<ResourceType>.<ResourceName>` - you can then perform any CDK action on these resulting resoureces.
 */
export class AmplifyGraphqlApi extends Construct {
  /**
   * Generated L1 and L2 CDK resources.
   */
  public readonly resources: AmplifyGraphqlApiResources;

  /**
   * Generated assets required for codegen steps. Persisted in order to render as part of the output strategy.
   */
  private readonly codegenAssets: CodegenAssets;

  /**
   * Resolvers generated by the transform process, persisted on the side in order to facilitate pulling a manifest
   * for the purposes of inspecting and producing overrides.
   */
  public readonly generatedFunctionSlots: FunctionSlot[];

  /**
   * New AmplifyGraphqlApi construct, this will create an appsync api with authorization, a schema, and all necessary resolvers, functions,
   * and datasources.
   * @param scope the scope to create this construct within.
   * @param id the id to use for this api.
   * @param props the properties used to configure the generated api.
   */
  constructor(scope: Construct, id: string, props: AmplifyGraphqlApiProps) {
    super(scope, id);

    const {
      definition,
      authorizationConfig,
      conflictResolution,
      functionSlots,
      transformers,
      predictionsBucket,
      stackMappings,
      translationBehavior,
      functionNameMap,
      outputStorageStrategy,
    } = props;

    addAmplifyMetadataToStackDescription(scope);

    const { authConfig, identityPoolId, adminRoles, authSynthParameters } =
      convertAuthorizationModesToTransformerAuthConfig(authorizationConfig);

    validateFunctionSlots(functionSlots ?? []);
    const separatedFunctionSlots = separateSlots([...(functionSlots ?? []), ...definition.functionSlots]);

    // Allow amplifyEnvironmentName to be retrieve from context, and use value 'NONE' if no value can be found.
    // amplifyEnvironmentName is required for logical id suffixing, as well as Exports from the nested stacks.
    // Allow export so customers can reuse the env in their own references downstream.
    const amplifyEnvironmentName = this.node.tryGetContext('amplifyEnvironmentName') ?? 'NONE';
    if (amplifyEnvironmentName.length > 8) {
      throw new Error(`or cdk --context env must have a length <= 8, found ${amplifyEnvironmentName}`);
    }

    const assetManager = new AssetManager();

    executeTransform({
      scope: this,
      nestedStackProvider: {
        provide: (nestedStackScope: Construct, name: string) => new NestedStack(nestedStackScope, name),
      },
      assetProvider: {
        provide: (assetScope: Construct, assetId: string, assetProps: AssetProps) =>
          new Asset(assetScope, assetId, { path: assetManager.addAsset(assetProps.fileName, assetProps.fileContent) }),
      },
      synthParameters: {
        amplifyEnvironmentName: amplifyEnvironmentName,
        apiName: props.apiName ?? id,
        ...authSynthParameters,
      },
      schema: definition.schema,
      userDefinedSlots: parseUserDefinedSlots(separatedFunctionSlots),
      transformersFactoryArgs: {
        authConfig,
        identityPoolId,
        adminRoles,
        customTransformers: transformers ?? [],
        ...(predictionsBucket ? { storageConfig: { bucketName: predictionsBucket.bucketName } } : {}),
        functionNameMap,
      },
      authConfig,
      stackMapping: stackMappings ?? {},
      resolverConfig: conflictResolution ? convertToResolverConfig(conflictResolution) : undefined,
      transformParameters: {
        ...defaultTranslationBehavior,
        ...(translationBehavior ?? {}),
      },
    });

    this.codegenAssets = new CodegenAssets(this, 'AmplifyCodegenAssets', { modelSchema: definition.schema });

    this.resources = getGeneratedResources(this);
    this.generatedFunctionSlots = getGeneratedFunctionSlots(assetManager.resolverAssets);
    this.storeOutput(outputStorageStrategy);
  }

  /**
   * Stores graphql api output to be used for client config generation
   * @param outputStorageStrategy Strategy to store construct outputs. If no strategy is provided a default strategy will be used.
   */
  private storeOutput(outputStorageStrategy?: IBackendOutputStorageStrategy): void {
    const stack = Stack.of(this);
    const output: GraphqlOutput = {
      version: '1',
      payload: {
        awsAppsyncApiId: this.resources.cfnResources.cfnGraphqlApi.attrApiId,
        awsAppsyncApiEndpoint: this.resources.cfnResources.cfnGraphqlApi.attrGraphQlUrl,
        awsAppsyncAuthenticationType: this.resources.cfnResources.cfnGraphqlApi.authenticationType as AwsAppsyncAuthenticationType,
        awsAppsyncRegion: stack.region,
        amplifyApiModelSchemaS3Uri: this.codegenAssets.modelSchemaS3Uri,
      },
    };

    if (this.resources.cfnResources.cfnApiKey) {
      output.payload.awsAppsyncApiKey = this.resources.cfnResources.cfnApiKey.attrApiKey;
    }

    const strategy = outputStorageStrategy ? outputStorageStrategy : new StackMetadataBackendOutputStorageStrategy(stack);
    strategy.addBackendOutputEntry(GraphqlOutputKey, output);

    // only flush if using default outputStorageStrategy
    if (!outputStorageStrategy) {
      strategy.flush();
    }
  }
}
