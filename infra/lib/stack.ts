import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(REPO_ROOT, 'apps', 'api');
const WEB_DIST = path.join(REPO_ROOT, 'apps', 'web', 'dist');

/**
 * Composition:
 * 1. MongoDB Atlas (external, M0 free tier) — connection string passed to
 *    Lambdas via env var. No VPC or RDS needed. Simpler + free tier forever.
 * 2. Two Lambda "profiles":
 *    - REST handlers behind API Gateway HTTP API (auth, posts, tags, authors, me).
 *    - Chat handler exposed via Lambda Function URL with RESPONSE_STREAM invoke mode.
 *      API Gateway does not support Lambda response streaming, hence the split.
 * 3. Frontend: S3 (private) + CloudFront with OAC.
 * 4. Secrets in SSM Parameter Store (free tier) — JWT_SECRET + MONGODB_URI + OPENROUTER_API_KEY.
 */
export class BlogAssistantStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const mongoUri =
      process.env.MONGODB_URI ??
      (() => {
        throw new Error(
          'Set MONGODB_URI in your environment before deploying (Atlas connection string)',
        );
      })();
    const mongoDb = process.env.MONGODB_DB ?? 'blog';
    const jwtSecret =
      process.env.JWT_SECRET ??
      (() => {
        throw new Error('Set JWT_SECRET (min 32 chars) in your environment before deploying');
      })();
    const openrouterApiKey = process.env.OPENROUTER_API_KEY ?? '';
    const openrouterModel = process.env.OPENROUTER_MODEL ?? '';
    const corsOrigin = process.env.CORS_ALLOWED_ORIGIN ?? '*';
    // `CORS_ALLOWED_ORIGIN` is comma-separated so a single env var can permit
    // multiple origins. API Gateway needs an array; runtime code parses the
    // string itself.
    const corsOriginList = corsOrigin
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // ── Secrets in SSM (free tier) ─────────────────────────────────────
    const jwtParam = new ssm.StringParameter(this, 'JwtSecretParam', {
      parameterName: '/blog/jwt-secret',
      stringValue: jwtSecret,
      tier: ssm.ParameterTier.STANDARD,
    });
    const mongoUriParam = new ssm.StringParameter(this, 'MongoUriParam', {
      parameterName: '/blog/mongodb-uri',
      stringValue: mongoUri,
      tier: ssm.ParameterTier.STANDARD,
    });
    const openrouterParam = openrouterApiKey
      ? new ssm.StringParameter(this, 'OpenRouterKeyParam', {
          parameterName: '/blog/openrouter-key',
          stringValue: openrouterApiKey,
          tier: ssm.ParameterTier.STANDARD,
        })
      : undefined;

    // ── Lambda config ──────────────────────────────────────────────────
    const commonEnv = {
      MONGODB_URI: mongoUri,
      MONGODB_DB: mongoDb,
      JWT_SECRET: jwtSecret,
      OPENROUTER_API_KEY: openrouterApiKey,
      OPENROUTER_MODEL: openrouterModel,
      CORS_ALLOWED_ORIGIN: corsOrigin,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const bundling = {
      target: 'node20',
      format: OutputFormat.ESM,
      externalModules: [],
      mainFields: ['module', 'main'],
      esbuildArgs: { '--conditions': 'module' },
      // ESM output turns CommonJS `require()` inside deps (jsonwebtoken →
      // jws → safe-buffer require 'buffer') into a stub that throws
      // "Dynamic require of X is not supported". Injecting a real require via
      // createRequire lets esbuild's dynamic-require helper resolve them.
      banner: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
      minify: true,
      sourceMap: true,
    };

    const makeFn = (id: string, entry: string, handler = 'handler') =>
      new NodejsFunction(this, id, {
        entry: path.join(API_DIR, entry),
        handler,
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(15),
        environment: commonEnv,
        bundling,
      });

    const signupFn = makeFn('SignupFn', 'src/handlers/auth.ts', 'signup');
    const loginFn = makeFn('LoginFn', 'src/handlers/auth.ts', 'login');
    const meFn = makeFn('MeFn', 'src/handlers/auth.ts', 'me');
    const listPublicFn = makeFn('ListPublicFn', 'src/handlers/posts.ts', 'listPublic');
    const listMineFn = makeFn('ListMineFn', 'src/handlers/posts.ts', 'listMine');
    const getOneFn = makeFn('GetOneFn', 'src/handlers/posts.ts', 'getOne');
    const createPostFn = makeFn('CreatePostFn', 'src/handlers/posts.ts', 'create');
    const updatePostFn = makeFn('UpdatePostFn', 'src/handlers/posts.ts', 'update');
    const deletePostFn = makeFn('DeletePostFn', 'src/handlers/posts.ts', 'remove');
    const listTagsFn = makeFn('ListTagsFn', 'src/handlers/posts.ts', 'listTags');
    const getAuthorFn = makeFn('GetAuthorFn', 'src/handlers/authors.ts', 'getProfile');

    // Chat function needs a longer timeout for LLM streaming.
    const chatFn = new NodejsFunction(this, 'ChatFn', {
      entry: path.join(API_DIR, 'src/handlers/chat.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(60),
      environment: commonEnv,
      bundling,
    });

    const allFns = [
      signupFn,
      loginFn,
      meFn,
      listPublicFn,
      listMineFn,
      getOneFn,
      createPostFn,
      updatePostFn,
      deletePostFn,
      listTagsFn,
      getAuthorFn,
      chatFn,
    ];
    for (const fn of allFns) {
      jwtParam.grantRead(fn);
      mongoUriParam.grantRead(fn);
    }
    openrouterParam?.grantRead(chatFn);

    // ── HTTP API ────────────────────────────────────────────────────────
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: corsOriginList,
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
      },
    });

    const route = (
      method: apigw.HttpMethod,
      apiPath: string,
      fn: lambda.IFunction,
      integrationId: string,
    ) =>
      httpApi.addRoutes({
        path: apiPath,
        methods: [method],
        integration: new HttpLambdaIntegration(`${integrationId}Int`, fn),
      });

    route(apigw.HttpMethod.POST, '/auth/signup', signupFn, 'Signup');
    route(apigw.HttpMethod.POST, '/auth/login', loginFn, 'Login');
    route(apigw.HttpMethod.GET, '/me', meFn, 'Me');
    route(apigw.HttpMethod.GET, '/me/posts', listMineFn, 'ListMine');
    route(apigw.HttpMethod.GET, '/posts', listPublicFn, 'ListPublic');
    route(apigw.HttpMethod.GET, '/posts/{id}', getOneFn, 'GetOne');
    route(apigw.HttpMethod.POST, '/posts', createPostFn, 'CreatePost');
    route(apigw.HttpMethod.PATCH, '/posts/{id}', updatePostFn, 'UpdatePost');
    route(apigw.HttpMethod.DELETE, '/posts/{id}', deletePostFn, 'DeletePost');
    route(apigw.HttpMethod.GET, '/tags', listTagsFn, 'ListTags');
    route(apigw.HttpMethod.GET, '/authors/{id}', getAuthorFn, 'GetAuthor');

    // CORS is owned entirely by the chat handler (see openStream() in
    // src/handlers/chat.ts), which echoes the exact request origin and answers
    // OPTIONS preflight itself. Do NOT set `cors` here: a Function URL's native
    // CORS also stamps Access-Control-Allow-Origin on actual responses, which
    // would collide with the handler's header and produce a duplicated
    // `origin, origin` value the browser rejects.
    const chatUrl = chatFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // ── Frontend hosting ───────────────────────────────────────────────
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Cast to IBucket: newer CDK types declare `isWebsite: boolean` on IBucket
    // but Bucket itself types it as `boolean | undefined`, which conflicts
    // under `exactOptionalPropertyTypes: true`. The cast is safe because
    // Bucket satisfies IBucket at runtime.
    const siteBucketRef = siteBucket as s3.IBucket;

    const distribution = new cf.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucketRef),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      priceClass: cf.PriceClass.PRICE_CLASS_100,
    });

    if (webBuildExists()) {
      new s3deploy.BucketDeployment(this, 'SiteDeployment', {
        sources: [s3deploy.Source.asset(WEB_DIST)],
        destinationBucket: siteBucketRef,
        distribution,
        distributionPaths: ['/*'],
      });
    }

    // Allow all Lambdas to read the shared SSM parameters explicitly.
    for (const fn of allFns) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [jwtParam.parameterArn, mongoUriParam.parameterArn],
        }),
      );
    }

    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'ChatUrl', { value: chatUrl.url });
    new CfnOutput(this, 'SiteUrl', { value: `https://${distribution.domainName}` });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}

const webBuildExists = (): boolean =>
  existsSync(WEB_DIST) && existsSync(path.join(WEB_DIST, 'index.html'));
