import { TransformerContextProvider, TransformerResolverProvider } from '@aws-amplify/graphql-transformer-interfaces';
import {
  Expression,
  printBlock,
  compoundExpression,
  set,
  ref,
  list,
  qref,
  methodCall,
  str
} from 'graphql-mapping-template';
import { PrimaryKeyDirectiveConfiguration } from '../../types';
import _ from 'lodash';
import {
  addIndexToResolverSlot,
  getResolverObject,
  mergeInputsAndDefaultsSnippet,
  ensureCompositeKeySnippet,
  validateSortDirectionInput
} from '../resolvers';
import {
  PrimaryKeyVTLGenerator,
} from "./vtl-generator";

export class RDSPrimaryKeyVTLGenerator implements PrimaryKeyVTLGenerator {
  generate = (config: PrimaryKeyDirectiveConfiguration, ctx: TransformerContextProvider, resolverMap: Map<TransformerResolverProvider, string>): void => {
    this.updateResolvers(config, ctx, resolverMap);
  };

  updateResolvers = (config: PrimaryKeyDirectiveConfiguration, ctx: TransformerContextProvider, resolverMap: Map<TransformerResolverProvider, string>): void => {
    const getResolver = getResolverObject(config, ctx, 'get');
    const listResolver = getResolverObject(config, ctx, 'list');
    const createResolver = getResolverObject(config, ctx, 'create');
    const updateResolver = getResolverObject(config, ctx, 'update');
    const deleteResolver = getResolverObject(config, ctx, 'delete');

    if (getResolver) {
      addIndexToResolverSlot(getResolver, [this.setPrimaryKeySnippet(config)]);
    }

    if (listResolver) {
      const sortDirectionValidation = printBlock('Validate the sort direction input')(compoundExpression(validateSortDirectionInput(config)));
      addIndexToResolverSlot(listResolver, [
        this.setPrimaryKeySnippet(config),
        sortDirectionValidation
      ]);
    }

    if (createResolver) {
      addIndexToResolverSlot(createResolver, [
        mergeInputsAndDefaultsSnippet(),
        this.setPrimaryKeySnippet(config),
        ensureCompositeKeySnippet(config, false),
      ]);
    }

    if (updateResolver) {
      addIndexToResolverSlot(updateResolver, [
        mergeInputsAndDefaultsSnippet(),
        this.setPrimaryKeySnippet(config),
        ensureCompositeKeySnippet(config, false),
      ]);
    }

    if (deleteResolver) {
      addIndexToResolverSlot(deleteResolver, [mergeInputsAndDefaultsSnippet(), this.setPrimaryKeySnippet(config)]);
    }
  };

  setPrimaryKeySnippet = (config: PrimaryKeyDirectiveConfiguration): string => {
    const expressions: Expression[] = [
      set(ref('keys'), list([])),
      qref(methodCall(ref('keys.add'), str(config.field.name.value)))
    ];

    config.sortKeyFields.map( field => {
      expressions.push(
        qref(methodCall(ref('keys.add'), str(field)))
      );
    });

    expressions.push(qref(methodCall(ref('ctx.args.metadata.put'), str('keys'), ref('keys'))),);

    return printBlock('Set the primary key information in metadata')(compoundExpression(expressions));
  };
};
