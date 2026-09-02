# Changelog

## [0.23.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.22.0...v0.23.0) (2026-09-02)


### Features

* Add span annotations and project labels client ([#349](https://github.com/introspection-org/introspection-js-sdk/issues/349)) ([8066e76](https://github.com/introspection-org/introspection-js-sdk/commit/8066e76482095662cd461a0e314acce0fc0b41f2))
* **connectors:** support Pipedream app authorization ([#360](https://github.com/introspection-org/introspection-js-sdk/issues/360)) ([24ebde9](https://github.com/introspection-org/introspection-js-sdk/commit/24ebde9212d5b889490cf05cfc412decdb02743b))
* **conversations:** add metadata filter, response field and dict param ([#341](https://github.com/introspection-org/introspection-js-sdk/issues/341)) ([1fda0d3](https://github.com/introspection-org/introspection-js-sdk/commit/1fda0d301b376f51de131dc41be1ed7dd381e2bb))


### Bug Fixes

* expose conversation task titles ([48a0608](https://github.com/introspection-org/introspection-js-sdk/commit/48a06082c9b93499a68518a05f84f9028876f9cd))
* **proxy:** preserve egress authority through dev relay ([#361](https://github.com/introspection-org/introspection-js-sdk/issues/361)) ([8b8b715](https://github.com/introspection-org/introspection-js-sdk/commit/8b8b7157893a6ac31a3e4e5cdb78d64ac5049268))

## [0.22.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.21.1...v0.22.0) (2026-08-13)


### Features

* **connectors:** add connectors, connections, and the install link ([#326](https://github.com/introspection-org/introspection-js-sdk/issues/326)) ([aed6074](https://github.com/introspection-org/introspection-js-sdk/commit/aed60748ec58787c578d921f8ee9fccf490e5a24))


### Bug Fixes

* **auth-example:** align with the current SDK session flow ([#328](https://github.com/introspection-org/introspection-js-sdk/issues/328)) ([5b0b24f](https://github.com/introspection-org/introspection-js-sdk/commit/5b0b24fd1df1fecb29e25e1782091fdd0c7f2e67))
* expose file tags, and drop identity_key ([#330](https://github.com/introspection-org/introspection-js-sdk/issues/330)) ([5543a28](https://github.com/introspection-org/introspection-js-sdk/commit/5543a2888e3521a1697dad06bbf3813ba72b390b))

## [0.21.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.21.0...v0.21.1) (2026-08-10)


### Bug Fixes

* **ci:** remove competing release tagger ([#324](https://github.com/introspection-org/introspection-js-sdk/issues/324)) ([4e2db67](https://github.com/introspection-org/introspection-js-sdk/commit/4e2db6781768b9c856e839a776d67927e6fd8cf2))

## [0.21.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.20.0...v0.21.0) (2026-08-10)


### ⚠ BREAKING CHANGES

* the ./mastra and ./langchain subpath exports and the AnthropicInstrumentor, GeminiInstrumentor, IntrospectionTracingProcessor, tracedMessagesCreate, tracedEmbeddingsCreate, getLangchainHandler, getMastraExporter, and OpenAI/Gemini converter exports are removed.
* experiments.create/update/delete and recipes.create/update/delete are removed, along with the RecipeCreate, RecipeUpdate, ExperimentCreate and ExperimentUpdate types. Use the CLI to author definitions.

### Features

* align the SDK with the current API and the runner-plane boundary ([#302](https://github.com/introspection-org/introspection-js-sdk/issues/302)) ([8428f4e](https://github.com/introspection-org/introspection-js-sdk/commit/8428f4e13f5da2b8bc7443bb1f6a359eefb5539d))
* **conversations:** expose complete export streams ([#306](https://github.com/introspection-org/introspection-js-sdk/issues/306)) ([a9bdf34](https://github.com/introspection-org/introspection-js-sdk/commit/a9bdf344d4e53ee84fb078e3ad222f3ca23b81a4))


### Bug Fixes

* **deps:** repair the duplicated lockfile key that broke every CI job ([#320](https://github.com/introspection-org/introspection-js-sdk/issues/320)) ([ffebe85](https://github.com/introspection-org/introspection-js-sdk/commit/ffebe8592ef05ab97e4afef9626c3b65489e9cfe))
* drop runtime-list filters the API never accepted ([#305](https://github.com/introspection-org/introspection-js-sdk/issues/305)) ([2a330f4](https://github.com/introspection-org/introspection-js-sdk/commit/2a330f4a8c3d2a7ef1d3fcf55dd3e7fdd44c5e09))


### Code Refactoring

* reduce to Pi + manual instrumentation, and the defect pass over it ([#307](https://github.com/introspection-org/introspection-js-sdk/issues/307)) ([6ce08a1](https://github.com/introspection-org/introspection-js-sdk/commit/6ce08a1b572041fcd8be2df00e6711140b94e687))

## [0.20.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.19.1...v0.20.0) (2026-08-07)


### Features

* **conversations:** add summary resources and agent selection ([#297](https://github.com/introspection-org/introspection-js-sdk/issues/297)) ([d0af5fd](https://github.com/introspection-org/introspection-js-sdk/commit/d0af5fde557e87d96a8b56f72735096e28eac28a))

## [0.19.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.19.0...v0.19.1) (2026-08-06)


### Bug Fixes

* preserve complete GenAI telemetry payloads ([#298](https://github.com/introspection-org/introspection-js-sdk/issues/298)) ([eef4baa](https://github.com/introspection-org/introspection-js-sdk/commit/eef4baaf4f01173d66e5d927c3d07aeb25d4d286))

## [0.19.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.18.1...v0.19.0) (2026-08-06)


### Features

* **types:** add `files` to task and task-run params ([#295](https://github.com/introspection-org/introspection-js-sdk/issues/295)) ([67a482c](https://github.com/introspection-org/introspection-js-sdk/commit/67a482c49aa650109d46084a562096c3ef301b2c))

## [0.18.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.18.0...v0.18.1) (2026-08-05)


### Bug Fixes

* **coding-agent:** enforce capture consent boundaries ([#293](https://github.com/introspection-org/introspection-js-sdk/issues/293)) ([fd6d520](https://github.com/introspection-org/introspection-js-sdk/commit/fd6d5203a0faf591a1c00a48321cc8e1e4d520ce))

## [0.18.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.17.0...v0.18.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* **conversations:** `ConversationItem`, `ConversationItemList`, `ConversationSummary`, `ConversationResponse`, `IntrospectionMetadata` and `ConversationItemNodeType` are removed, not deprecated — replaced outright by `GenAiSpan` / `GenAiSpanList` and the `gen_ai.*` / `introspection.*` attribute types. `conversations.retrieve()` now resolves to `GenAiSpan | null`, `items.get()`/`items.list()` to spans addressed by `span_id` rather than `id`, and `ConversationItemInclude` is narrowed to `"events" | "resource_attributes"`. `node_type` is gone from the wire: it was a precomputed UI tree hint with no semconv equivalent, derived client-side from `gen_ai.operation.name` + `parent_span_id`.

### Features

* **conversations:** replace the flat conversation types with GenAiSpan ([#290](https://github.com/introspection-org/introspection-js-sdk/issues/290)) ([b04d439](https://github.com/introspection-org/introspection-js-sdk/commit/b04d439ebfe1e2de10ce8ca7012bc652eb615d95))

## [0.17.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.16.0...v0.17.0) (2026-08-05)


### Features

* **coding-agent:** add opt-in Claude Code / Codex session capture ([#287](https://github.com/introspection-org/introspection-js-sdk/issues/287)) ([624deb1](https://github.com/introspection-org/introspection-js-sdk/commit/624deb17426379278575e932cfe412104c15616a))

## [0.16.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.15.0...v0.16.0) (2026-08-04)


### Features

* **browser:** environment-scoped DP sessions ([#286](https://github.com/introspection-org/introspection-js-sdk/issues/286)) ([ce8e759](https://github.com/introspection-org/introspection-js-sdk/commit/ce8e7594d8cc733f78a2b1bbcbc7e9ade4d017a5))

## [0.15.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.14.0...v0.15.0) (2026-07-29)


### Features

* **otel:** trace OpenAI embedding usage ([#267](https://github.com/introspection-org/introspection-js-sdk/issues/267)) ([a9d15f5](https://github.com/introspection-org/introspection-js-sdk/commit/a9d15f56576e66e199d0903a2c9b0630d69da48f))
* paginate conversation items with opaque cursors ([#266](https://github.com/introspection-org/introspection-js-sdk/issues/266)) ([51541f1](https://github.com/introspection-org/introspection-js-sdk/commit/51541f1afd5bcd9e51be122a83d92ab29b236cd7))

## [0.14.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.13.0...v0.14.0) (2026-07-29)


### Features

* **node:** route tasks to a named dev server via INTROSPECTION_DEV_TARGET ([#263](https://github.com/introspection-org/introspection-js-sdk/issues/263)) ([310499e](https://github.com/introspection-org/introspection-js-sdk/commit/310499e32a9921ada4fb83eab2f30971658e16b7))

## [0.13.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.12.0...v0.13.0) (2026-07-26)


### Features

* **introspection-pi:** add instrumentSession and gen_ai content scrubbing ([#246](https://github.com/introspection-org/introspection-js-sdk/issues/246)) ([d582231](https://github.com/introspection-org/introspection-js-sdk/commit/d582231e71f76bc2bd9bb20858996acec08399d9))


### Bug Fixes

* **deps:** align all @earendil-works/pi-* to 0.80.10 (unblock release build) ([#241](https://github.com/introspection-org/introspection-js-sdk/issues/241)) ([2856d41](https://github.com/introspection-org/introspection-js-sdk/commit/2856d41e78ffbb862493545eba07be056f35da54))
* drop clear from TaskRunKind ([#243](https://github.com/introspection-org/introspection-js-sdk/issues/243)) ([a5b423b](https://github.com/introspection-org/introspection-js-sdk/commit/a5b423b62560dc8dcbcc10cebeb4dd8b8069ca7a))

## [0.12.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.11.0...v0.12.0) (2026-07-24)


### ⚠ BREAKING CHANGES

* **experiments:** ExperimentCreate requires runtime_group_id, arms of {runtime_id, arm_label}, and goal_json; Arm and ExperimentEndParams are removed; end() no longer accepts a winner label.
* RuntimeResolutionMode is removed from @introspection/types.

### Features

* add environment_ref to Runtime; drop RuntimeResolutionMode ([#237](https://github.com/introspection-org/introspection-js-sdk/issues/237)) ([732524a](https://github.com/introspection-org/introspection-js-sdk/commit/732524a9b552ecde420c54e987ce3ceb6de5f720))


### Bug Fixes

* **experiments:** align the experiments contract with the CP API ([#235](https://github.com/introspection-org/introspection-js-sdk/issues/235)) ([1a1e9c5](https://github.com/introspection-org/introspection-js-sdk/commit/1a1e9c57d98e3d31a5e135ca78136308583ac09c))

## [0.11.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.10.0...v0.11.0) (2026-07-18)


### ⚠ BREAKING CHANGES

* the grain-based events surface is replaced by the typed six-family discriminated read per the telemetry-read-resources spec. RawEvent, EventGrain, EventInclude, and the grain/include/ event_name_prefix/q/q_regex params are deleted. EventsClient.list() now REQUIRES event_name (exactly one family) and returns family-typed rows (Event union member with envelope + nested typed payload); unknown families surface as UnknownEvent instead of failing. Adds the columnar events.arrow()/conversations.arrow() accessor (apache-arrow Table per page + readAll()) and deep-converts Arrow struct payload columns to plain JSON-shaped objects.

### Features

* typed discriminated events read (required event_name) + columnar arrow() accessor ([#216](https://github.com/introspection-org/introspection-js-sdk/issues/216)) ([a55b430](https://github.com/introspection-org/introspection-js-sdk/commit/a55b430b77c01d3e5c704693938727d94d2d4791))


### Bug Fixes

* align SDK execution contracts ([#222](https://github.com/introspection-org/introspection-js-sdk/issues/222)) ([5aabb4e](https://github.com/introspection-org/introspection-js-sdk/commit/5aabb4e02cddd9bdf0cba5bab55866765e9e5a4f))
* **http:** decode Arrow int64 columns to plain numbers for JSON parity ([#219](https://github.com/introspection-org/introspection-js-sdk/issues/219)) ([013dd5b](https://github.com/introspection-org/introspection-js-sdk/commit/013dd5b6c58a80d2b314a1fe1aebe7d1b308b9d8))
* keep runtime SDK surface read and run only ([#223](https://github.com/introspection-org/introspection-js-sdk/issues/223)) ([d051351](https://github.com/introspection-org/introspection-js-sdk/commit/d051351943723124b9c854718a274d704155dd3a))

## [0.10.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.9.3...v0.10.0) (2026-07-17)


### Features

* runner-scoped events/metrics reads + Arrow decode ([#213](https://github.com/introspection-org/introspection-js-sdk/issues/213)) ([924d235](https://github.com/introspection-org/introspection-js-sdk/commit/924d2359e40b8d9f6bfddc845adfd50943481a2a))

## [0.9.3](https://github.com/introspection-org/introspection-js-sdk/compare/v0.9.2...v0.9.3) (2026-07-16)


### Bug Fixes

* add lazy proxy bootstrap ([#210](https://github.com/introspection-org/introspection-js-sdk/issues/210)) ([7351655](https://github.com/introspection-org/introspection-js-sdk/commit/73516556625242dcc53b1f13ddc32ab0131632f9))

## [0.9.2](https://github.com/introspection-org/introspection-js-sdk/compare/v0.9.1...v0.9.2) (2026-07-15)


### Bug Fixes

* preserve complete Pi telemetry results ([#208](https://github.com/introspection-org/introspection-js-sdk/issues/208)) ([7eb0cdc](https://github.com/introspection-org/introspection-js-sdk/commit/7eb0cdcc4bbfef9c68112f4686ed071161c03ce7))

## [0.9.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.9.0...v0.9.1) (2026-07-15)


### Bug Fixes

* make GitHub release creation idempotent ([#206](https://github.com/introspection-org/introspection-js-sdk/issues/206)) ([bf8f1c4](https://github.com/introspection-org/introspection-js-sdk/commit/bf8f1c4812194f53596fb1b64024b2e9850be6cb))

## [0.9.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.8.3...v0.9.0) (2026-07-15)


### ⚠ BREAKING CHANGES

* `ConversationSummary` no longer exposes `response_model`, `operation_name`, or `signal_categories`. The existing `model` and `agent_name` fields remain available and now represent the first requested model and first agent observed in the conversation.

### Bug Fixes

* align conversations types with the metrics API surface ([#188](https://github.com/introspection-org/introspection-js-sdk/pull/188)) ([ee83700](https://github.com/introspection-org/introspection-js-sdk/commit/ee83700e2b2f3a3e833721b27d7941f30b89b4ed))
* keep egress proxy connections warm ([#202](https://github.com/introspection-org/introspection-js-sdk/issues/202)) ([1693a33](https://github.com/introspection-org/introspection-js-sdk/commit/1693a331fa06fa1dab181e6b6a5c38777261fc7d))
* preserve conversation summary field names ([#205](https://github.com/introspection-org/introspection-js-sdk/issues/205)) ([affbf2a](https://github.com/introspection-org/introspection-js-sdk/commit/affbf2a0c34253aeb39aefc71ca3f312d8f80607))

## [0.8.3](https://github.com/introspection-org/introspection-js-sdk/compare/v0.8.2...v0.8.3) (2026-07-12)


### Bug Fixes

* Propagate trace context through proxy and Pi tools ([#186](https://github.com/introspection-org/introspection-js-sdk/issues/186)) ([e6f8ba5](https://github.com/introspection-org/introspection-js-sdk/commit/e6f8ba5c9637a8403fdc82d843936772b0c36153))

## [0.8.2](https://github.com/introspection-org/introspection-js-sdk/compare/v0.8.1...v0.8.2) (2026-07-10)


### Bug Fixes

* **node:** project all gen_ai/introspection/identity baggage onto infra spans ([#184](https://github.com/introspection-org/introspection-js-sdk/issues/184)) ([a3c4122](https://github.com/introspection-org/introspection-js-sdk/commit/a3c41220208c3408e07ec888915f169c27350676))

## [0.8.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.8.0...v0.8.1) (2026-07-10)


### Features

* **node:** export introspection infra spans through IntrospectionSpanProcessor ([#182](https://github.com/introspection-org/introspection-js-sdk/issues/182)) ([0732f97](https://github.com/introspection-org/introspection-js-sdk/commit/0732f97d36bd3f92d50de065ddd5fc9757cc81a1))


### Miscellaneous Chores

* release 0.8.1 ([d574422](https://github.com/introspection-org/introspection-js-sdk/commit/d574422611ac27533a58647891534742a0a64109))

## [0.8.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.7.2...v0.8.0) (2026-07-10)


### Features

* **proxy:** emit introspection-proxy-call OTel spans for proxied requests ([#180](https://github.com/introspection-org/introspection-js-sdk/issues/180)) ([d5b5412](https://github.com/introspection-org/introspection-js-sdk/commit/d5b5412d55c2323cf3ed7aa041449c0d8e25be39))

## [0.7.2](https://github.com/introspection-org/introspection-js-sdk/compare/v0.7.1...v0.7.2) (2026-07-10)


### Bug Fixes

* **genai:** align SDK telemetry with current OTel semantic conventions ([#177](https://github.com/introspection-org/introspection-js-sdk/issues/177)) ([fe4f723](https://github.com/introspection-org/introspection-js-sdk/commit/fe4f7237f0e0af5fcb0e008a4627137ae9bdc7d4))

## [0.7.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.7.0...v0.7.1) (2026-07-06)


### Bug Fixes

* trigger patch release ([d5e0309](https://github.com/introspection-org/introspection-js-sdk/commit/d5e0309278221440dc4c7a6e6ddfd053a7c6acfb))

## [0.7.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.6.5...v0.7.0) (2026-07-05)

### Features

- **ci:** adopt release-please for versioning; rename VERSION to version.txt ([#156](https://github.com/introspection-org/introspection-js-sdk/issues/156)) ([8966038](https://github.com/introspection-org/introspection-js-sdk/commit/8966038812a102b25ca419d5269ab2c1162a7f57))
- **ci:** release-please cuts the tag on release-PR merge ([#158](https://github.com/introspection-org/introspection-js-sdk/issues/158)) ([b9aac25](https://github.com/introspection-org/introspection-js-sdk/commit/b9aac25839be4ed6c2408714ee91abf8530db3fd))
