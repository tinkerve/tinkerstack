import { stitchSchemas } from "@graphql-tools/stitch";
import { MapperKind, mapSchema } from "@graphql-tools/utils";
import { FilterRootFields, wrapSchema } from "@graphql-tools/wrap";
import { Injectable, Logger, ParamData } from "@nestjs/common";
import {
  ExternalContextCreator,
  MetadataScanner,
  ParamsFactory,
} from "@nestjs/core";
import { ParamMetadata } from "@nestjs/core/helpers/interfaces/params-metadata.interface";
import {
  GqlContextType,
  GraphQLExecutionContext,
  PARAM_ARGS_METADATA,
} from "@nestjs/graphql";
import { GqlParamtype } from "@nestjs/graphql/dist/enums/gql-paramtype.enum";
import { GraphQLResolveInfo, GraphQLSchema } from "graphql";
import { GraphQLClient } from "graphql-request";
import {
  ANNOTATION_RESOLVER_METADATA,
  AnnotationResolverMetadata,
  AnnotationSchemaSources,
  ResolverName,
} from "./annotation.constants";
import {
  ANNOTATION_QUERY_NAME,
  GraphQLAnnotationMeta,
  GraphQLAnnotationResolver,
} from "./annotation.resolver";
import {
  isPlainObject,
  loadGraphQLSchema,
  shallowMerge,
  split,
} from "./annotation.utils";
import { ResolverDiscoveryService } from "./resolver.explorer";
import { instanceToPlain } from "class-transformer";

@Injectable()
export class GraphQLAnnotatedSchemaLoader {
  private _logger = new Logger("GraphQLAnnotationModule");

  constructor(
    private readonly resolverDiscoveryService: ResolverDiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly externalContextCreator: ExternalContextCreator,
  ) {}

  public async load(
    sources: AnnotationSchemaSources,
    opts?: { ignoreMissingSources?: boolean },
  ) {
    const loadedSources = await this.batchLoadSources(sources, {
      ignoreMissingSources: opts?.ignoreMissingSources ?? false,
    });

    const schema = stitchSchemas({
      subschemas: loadedSources.map((s) => s.subschema),
    });
    const annotations = shallowMerge(
      loadedSources.map((s) => s.annotation),
    ) as GraphQLAnnotationMeta;
    const annotationResolvers = await this.discoverAnnotationResolvers();

    return this.embedAnnotationResolversToSchema(
      schema,
      annotations,
      annotationResolvers,
    );
  }

  private async discoverAnnotationResolvers() {
    type AnnotationName = string;
    type AnnotationCallback = (...args: any[]) => any;
    const annotationResolvers = new Map<AnnotationName, AnnotationCallback>();

    const paramFactory = new GraphQLAnnotationResolverParamsFactory();
    const instances = this.resolverDiscoveryService.explore();

    for (const { instance } of instances)
      for (const methodName of this.metadataScanner.getAllMethodNames(
        Object.getPrototypeOf(instance),
      )) {
        const resolverMeta = Reflect.getMetadata(
          ANNOTATION_RESOLVER_METADATA,
          instance[methodName],
        ) as AnnotationResolverMetadata;

        if (!resolverMeta) continue; // Skip non-annotated

        this._logger.log(
          `Discovered resolver for annotation "${resolverMeta.annotation}"`,
        );
        annotationResolvers.set(
          resolverMeta.annotation,
          this.externalContextCreator.create<
            Record<number, ParamMetadata>,
            GqlContextType
          >(
            instance,
            instance[methodName],
            methodName,
            PARAM_ARGS_METADATA,
            paramFactory,
            undefined,
            undefined,
            undefined,
            "graphql",
          ),
        );
      }

    return annotationResolvers;
  }

  private async batchLoadSources(
    sources: AnnotationSchemaSources,
    opts?: { ignoreMissingSources?: boolean },
  ) {
    const pending = Object.entries(sources).map(async ([name, url]) => {
      const loadId = `${name}@${url}`;
      try {
        const loaded = {
          id: loadId,
          url: url,
          name: name,
          subschema: await loadGraphQLSchema(url),
          annotation: await this.loadAnnotations(url),
        };

        // Cleanup
        // Remove `_annotations` from being merged to main schema
        loaded.subschema.transforms = [
          new FilterRootFields(
            (op, fieldName) => !fieldName.endsWith(ANNOTATION_QUERY_NAME),
          ),
        ];

        this._logger.log(`Loaded schema for ${loadId}`);
        return loaded;
      } catch (err) {
        this._logger.error(`Unable to load schema for ${loadId}`);
        throw err;
      }
    });

    const [loaded, failed] = split(
      await Promise.allSettled(pending),
      (q) => q.status === "fulfilled",
    );

    const shouldThrow = opts?.ignoreMissingSources ?? true;
    if (failed.length > 0) {
      if (shouldThrow)
        throw new Error(
          `Failed to load ${failed.length} schema(s) from sources.`,
        );
      else this._logger.warn(`Failed to load ${failed.length}, ignoring.`);
    }

    return loaded.map((l) => l.value);
  }

  private async loadAnnotations(url: string) {
    const client = new GraphQLClient(url);

    try {
      type ExpectedResult = {
        [ANNOTATION_QUERY_NAME]: GraphQLAnnotationMeta;
      };
      const res = await client.rawRequest<ExpectedResult>(`
        query IntrospectAnnotations {
          ${ANNOTATION_QUERY_NAME} {
            name
            resolvers
          }
        }
      `);

      this._logger.log(`Loaded annotations for ${url}`);
      return res.data[ANNOTATION_QUERY_NAME];
    } catch (err) {
      this._logger.warn(`Failed to load annotations at ${url}, assuming empty`);
      return {} as GraphQLAnnotationMeta;
    }
  }

  private async embedAnnotationResolversToSchema(
    schema: GraphQLSchema,
    annotations: GraphQLAnnotationMeta,
    annotationResolvers: Map<ResolverName, (...args: any[]) => any>,
  ) {
    return mapSchema(schema, {
      [MapperKind.ROOT_FIELD]: (fieldSchema, name, type) => {
        const fieldAnnotations = (annotations.resolvers[name] ?? [])
          .map((info) => ({
            ...info,
            resolver: annotationResolvers.get(info.annotation)!, // NOTE: should be validated in filter
          }))
          .filter((info) => {
            const annotationHasResolver = info.resolver !== undefined;
            if (!annotationHasResolver)
              this._logger.warn(
                `Found unhandled annotation "${info.annotation}", skipping linking process`,
              );

            return annotationHasResolver;
          });

        if (fieldAnnotations.length <= 0) return fieldSchema; // No transform if there's no annotation

        // If there exist a resolver for an annotate parameter, remove it from schema to prevent external injection
        for (const annotation of fieldAnnotations)
          if (annotation.target.type === "parameter" && fieldSchema.args)
            delete fieldSchema.args[annotation.target.paramName];

        const defaultResolver = fieldSchema.resolve!;
        fieldSchema.resolve = async function (
          parent,
          args: Record<string, any>,
          context: GraphQLExecutionContext,
          info,
        ) {
          const annotationCallbacks = await Promise.all(
            fieldAnnotations.map(async (annotation) => ({
              annotation,
              return: await annotation.resolver(
                ...([
                  info.rootValue,
                  annotation.data as Record<string, unknown>,
                  context,
                  info,
                ] satisfies GraphQLAnnotationResolverArgs),
              ),
            })),
          );

          const resolvedParams = annotationCallbacks.reduce(
            (params, call) => {
              if (call.annotation.target.type !== "parameter") return params;

              const returnedClassType =
                typeof call.return === "object" && !isPlainObject(call.return);
              const returnValue = returnedClassType
                ? instanceToPlain(call.return)
                : call.return;
              params[call.annotation.target.paramName] = returnValue;

              return params;
            },
            {} as Record<string, any>,
          );

          return defaultResolver(
            parent,
            { ...args, ...resolvedParams },
            context,
            info,
          );
        };

        return fieldSchema;
      },
    });
  }
}

type GraphQLAnnotationResolverArgs = [
  // Root/parent (follows graphql context to match)
  any,
  // Data
  Record<string, unknown>,
  // GraphQL Context
  GraphQLExecutionContext,
  // GraphQL Resolver Info
  GraphQLResolveInfo,
];
class GraphQLAnnotationResolverParamsFactory implements ParamsFactory {
  // This param factory extends graphql's own just with different inputs from annotations instead.
  // https://github.com/nestjs/graphql/blob/master/packages/graphql/lib/factories/params.factory.ts#L9
  exchangeKeyForValue(
    type: number,
    possibleKey: ParamData,
    // NOTE: nestjs passes this in array, so we have to "get the first element"
    argsContext: GraphQLAnnotationResolverArgs,
  ) {
    if (!argsContext) return null;

    const args = {
      parentValue: argsContext[0],
      data: argsContext[1],
      context: argsContext[2],
      info: argsContext[3],
    };

    switch (type as GqlParamtype) {
      case GqlParamtype.ROOT:
        return args.parentValue;
      case GqlParamtype.ARGS:
        return possibleKey && args.data
          ? args.data[possibleKey as string]
          : args.data;
      case GqlParamtype.CONTEXT:
        return possibleKey && args.context
          ? args.context[possibleKey as string]
          : args.context;
      case GqlParamtype.INFO:
        return possibleKey && args.context
          ? args.info[possibleKey as string]
          : args.info;
      default:
        return null;
    }
  }
}
