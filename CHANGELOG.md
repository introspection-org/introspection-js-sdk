# Changelog

## [0.42.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.41.1...v0.42.0) (2026-10-24)


### Features

* approvals and missions resources for the Data Plane's AAuth routes ([#531](https://github.com/introspection-org/introspection-js-sdk/issues/531)) ([42e98e4](https://github.com/introspection-org/introspection-js-sdk/commit/42e98e48b3a896decfba9e9142c5ee0b4e5bc863))

## [0.41.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.41.0...v0.41.1) (2026-10-24)


### Bug Fixes

* **walk:** a poll reads a 404 as not yet ([#534](https://github.com/introspection-org/introspection-js-sdk/issues/534)) ([d0fc7c3](https://github.com/introspection-org/introspection-js-sdk/commit/d0fc7c396d5140b5be5c2e7f9404118088c0f5c6))
* **walk:** every run in a project of its own, so reruns and concurrent walks hold ([#533](https://github.com/introspection-org/introspection-js-sdk/issues/533)) ([857e31a](https://github.com/introspection-org/introspection-js-sdk/commit/857e31a2729f35a505e554e1a8e107039a7e5838))

## [0.41.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.40.0...v0.41.0) (2026-10-23)


### Features

* add the project administration and eval resources the CLI calls ([#519](https://github.com/introspection-org/introspection-js-sdk/issues/519)) ([be286ce](https://github.com/introspection-org/introspection-js-sdk/commit/be286ce79b70a3c13ae476b3d7cfeaf14d713fa2))

## [0.40.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.39.0...v0.40.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* `ConversationsClient.turns`, `ConversationTurn`, `ConversationTurnMessage`, `ConversationTurnList` and `ConversationTurnListParams` are removed.

### Features

* filter conversation items with contains=&lt;semconv path&gt;:&lt;value&gt; (name prefix wildcard) and drop turns ([#516](https://github.com/introspection-org/introspection-js-sdk/issues/516)) ([629ce0c](https://github.com/introspection-org/introspection-js-sdk/commit/629ce0c5d99cc685336a73aa23bbe29c9c9b2737))

## [0.39.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.38.1...v0.39.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **aauth:** import from @introspection-sdk/aauth-person-server. The old name is deprecated on npm and receives no further releases.
* **aauth:** import from @introspection-sdk/aauth-person-server. The old name is deprecated on npm and receives no further releases.

### Features

* **aauth:** federated access with a resource's own Access Server ([#505](https://github.com/introspection-org/introspection-js-sdk/issues/505)) ([1449245](https://github.com/introspection-org/introspection-js-sdk/commit/144924559f34c4f298b40717f4e21b5616d5215e))


### Bug Fixes

* **examples:** the travel demo signs in before it starts, and stops without a session ([#520](https://github.com/introspection-org/introspection-js-sdk/issues/520)) ([3818c9a](https://github.com/introspection-org/introspection-js-sdk/commit/3818c9a4d76e87bc4700a7dc1e0d72c3cfb951b3))


### Code Refactoring

* **aauth:** rename @introspection-sdk/person-server to aauth-person-server ([#517](https://github.com/introspection-org/introspection-js-sdk/issues/517)) ([844e1be](https://github.com/introspection-org/introspection-js-sdk/commit/844e1be67597f19ce39c294c1085d3f423554e83))

## [0.38.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.38.0...v0.38.1) (2026-10-21)


### Bug Fixes

* **examples:** show the helpers each docs region calls ([#513](https://github.com/introspection-org/introspection-js-sdk/issues/513)) ([023ef77](https://github.com/introspection-org/introspection-js-sdk/commit/023ef77b5c09dac93ffa86c8fc100950bdb97195))

## [0.38.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.37.0...v0.38.0) (2026-10-21)


### Features

* **examples:** docs reference snippet regions and a region check ([#500](https://github.com/introspection-org/introspection-js-sdk/issues/500)) ([a3cb0ca](https://github.com/introspection-org/introspection-js-sdk/commit/a3cb0ca916636b6d2e784da3000c471af3ec3b5e))
* **examples:** docs snippet regions for the pattern, observe and identity pages ([#501](https://github.com/introspection-org/introspection-js-sdk/issues/501)) ([4aef725](https://github.com/introspection-org/introspection-js-sdk/commit/4aef7257a054b979b85bd100c258851d62c51245))

## [0.37.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.36.0...v0.37.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **person-server:** every Store method takes `tenant: string | undefined` as its first parameter.

### Features

* **aauth-travel:** cancel a booking, on the person token of the agent that made it ([#503](https://github.com/introspection-org/introspection-js-sdk/issues/503)) ([f5df993](https://github.com/introspection-org/introspection-js-sdk/commit/f5df993a7ce661c44a1d2cd3db12e5d33fbe6085))


### Bug Fixes

* **aauth-travel:** name the approver as an identity when deciding on the hosted Person Server ([#502](https://github.com/introspection-org/introspection-js-sdk/issues/502)) ([a356844](https://github.com/introspection-org/introspection-js-sdk/commit/a356844280f356be2aab6a14b195a1d95d2d91a3))
* fail live runs on missing settings and multipart-encode FormData through the proxy ([#499](https://github.com/introspection-org/introspection-js-sdk/issues/499)) ([946c665](https://github.com/introspection-org/introspection-js-sdk/commit/946c665f94efd650b1039a6e0a308d17e92c7645))
* **person-server:** stop approval reuse, issuing under ended missions, and mission hash collisions ([#491](https://github.com/introspection-org/introspection-js-sdk/issues/491)) ([b713975](https://github.com/introspection-org/introspection-js-sdk/commit/b7139759579751a8b0ace9012e9c5f4d94c44733))

## [0.36.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.35.1...v0.36.0) (2026-10-19)


### Features

* @introspection-sdk/aauth-resource, with the travel booking provider built on it ([#489](https://github.com/introspection-org/introspection-js-sdk/issues/489)) ([9530f4e](https://github.com/introspection-org/introspection-js-sdk/commit/9530f4ee7ac35117c48fed7c79839aff05fa65ea))
* **examples:** the AAuth demo runs a named tunnel by its token, sets up idempotently, and can serve without setup ([#472](https://github.com/introspection-org/introspection-js-sdk/issues/472)) ([12f25a7](https://github.com/introspection-org/introspection-js-sdk/commit/12f25a75271af066d7b626c2e35a508cf892f74e))


### Bug Fixes

* **examples:** the AAuth demo's dev script names its temp files portably, so it runs on Linux ([#474](https://github.com/introspection-org/introspection-js-sdk/issues/474)) ([d542140](https://github.com/introspection-org/introspection-js-sdk/commit/d542140b6fefcacf1c10ced3f56bfcfc941aa4a9))
* **examples:** the AAuth demo's dev script reads a minted secret's JSON apart from the CLI's notices ([#475](https://github.com/introspection-org/introspection-js-sdk/issues/475)) ([f4c72fc](https://github.com/introspection-org/introspection-js-sdk/commit/f4c72fc1332b44af7658214285e90527ef19aab1))

## [0.35.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.35.0...v0.35.1) (2026-10-17)


### Bug Fixes

* **examples:** the AAuth demo books against the provider's real host and shows tool errors ([#469](https://github.com/introspection-org/introspection-js-sdk/issues/469)) ([0338dd2](https://github.com/introspection-org/introspection-js-sdk/commit/0338dd22ffa31aa3280a0f03c09cb1b2ec6661d6))

## [0.35.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.34.0...v0.35.0) (2026-10-16)


### Features

* **examples:** the AAuth travel demo sets itself up reliably, signs in with applications, and opens on the demo ([#464](https://github.com/introspection-org/introspection-js-sdk/issues/464)) ([551820d](https://github.com/introspection-org/introspection-js-sdk/commit/551820d79fcc0c4aa258857212a09378f2fbb9b6))
* **pi:** record the MCP server behind a tool on its execute_tool span ([#461](https://github.com/introspection-org/introspection-js-sdk/issues/461)) ([ed95ea8](https://github.com/introspection-org/introspection-js-sdk/commit/ed95ea8776774a7b65c9c915fca6d80571312d1f))


### Bug Fixes

* **examples:** AAuth travel demo polish after the first rehearsals ([#466](https://github.com/introspection-org/introspection-js-sdk/issues/466)) ([822af5e](https://github.com/introspection-org/introspection-js-sdk/commit/822af5e53c94d5c31ca60509a1c06914047ed358))
* **examples:** the AAuth demo header shows the Introspection mark beside its name ([#467](https://github.com/introspection-org/introspection-js-sdk/issues/467)) ([824a273](https://github.com/introspection-org/introspection-js-sdk/commit/824a273dde06d971d5dab5ecd2685fefc2c75977))
* let person-server publish, and state what a new published package needs ([#468](https://github.com/introspection-org/introspection-js-sdk/issues/468)) ([1ec5cf4](https://github.com/introspection-org/introspection-js-sdk/commit/1ec5cf4f80cd8e92721e36faa6278e0e280b01ef))

## [0.34.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.33.0...v0.34.0) (2026-10-15)


### ⚠ BREAKING CHANGES

* **tags:** `client.projectLabels` is now `client.tags`, `ProjectLabelsApi`/`attachProjectLabels` are `TagsApi`/`attachTags`, and `ProjectLabel{,Create,Update,ListParams}` are replaced by `Tag`, `TagCreate`, `TagUpdate` and `TagListParams`, which take a `TagKind`.

### Features

* **tags:** the tag catalogue, keyed by access or annotation ([#462](https://github.com/introspection-org/introspection-js-sdk/issues/462)) ([670d247](https://github.com/introspection-org/introspection-js-sdk/commit/670d247267165ca81f870f0d807cd292f307c56e))

## [0.33.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.32.0...v0.33.0) (2026-10-15)


### ⚠ BREAKING CHANGES

* **repositories:** `RepositoryProvider` is now `"github" | "introspection"`; `"hosted"` is no longer a member.

### Features

* **examples:** the AAuth travel demo ([#435](https://github.com/introspection-org/introspection-js-sdk/issues/435)) ([32ec303](https://github.com/introspection-org/introspection-js-sdk/commit/32ec303e9c1df1a5fe01b5fa1b307a1ccf88dbae))


### Bug Fixes

* **repositories:** the platform-served provider is `introspection` ([#459](https://github.com/introspection-org/introspection-js-sdk/issues/459)) ([390c5a8](https://github.com/introspection-org/introspection-js-sdk/commit/390c5a8c7383ae300598835883a1eaf8fa814707))

## [0.32.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.31.0...v0.32.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* **connectors:** Connector.approval_policy and Connector.person_server_mode are removed, along with the ConnectorApprovalPolicy and ConnectorPersonServerMode types and the matching create params. The control plane no longer serves or accepts them.

### Features

* **browser:** send ?project_id= so the DP picks the session cookie for the connected project ([#456](https://github.com/introspection-org/introspection-js-sdk/issues/456)) ([202ecda](https://github.com/introspection-org/introspection-js-sdk/commit/202ecdae2b9b4b4005b653f277b69cbf162416b1))
* **connectors:** AAuth connectors with Cedar policy entities, and member policy attributes ([#458](https://github.com/introspection-org/introspection-js-sdk/issues/458)) ([69e0951](https://github.com/introspection-org/introspection-js-sdk/commit/69e095143b2efeaa055cc5a341c20e36dd6edf1f))
* **proxy:** route proxy-native runtimes through HTTPS_PROXY ([#442](https://github.com/introspection-org/introspection-js-sdk/issues/442)) ([df43c00](https://github.com/introspection-org/introspection-js-sdk/commit/df43c00a075dab86da3038c279422edd984c428b))


### Bug Fixes

* declare repository on each published package for npm provenance ([#445](https://github.com/introspection-org/introspection-js-sdk/issues/445)) ([1d7c8ad](https://github.com/introspection-org/introspection-js-sdk/commit/1d7c8ad5727dd7f66503080d651cd51aeabd897e))
* **node:** honour HTTPS_PROXY on REST calls and name the host in network errors ([#457](https://github.com/introspection-org/introspection-js-sdk/issues/457)) ([117d710](https://github.com/introspection-org/introspection-js-sdk/commit/117d710e59fa7cf5a936e4c8df22c343e74654cc))

## [0.31.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.30.0...v0.31.0) (2026-10-12)


### Features

* **pi:** render a Pi session file as GenAI spans ([#443](https://github.com/introspection-org/introspection-js-sdk/issues/443)) ([2554025](https://github.com/introspection-org/introspection-js-sdk/commit/2554025544ef6c2a762b787644618bcf5e6b6ae6))


### Bug Fixes

* **pi:** hydrate tool-result images as images ([#439](https://github.com/introspection-org/introspection-js-sdk/issues/439)) ([9910ad8](https://github.com/introspection-org/introspection-js-sdk/commit/9910ad8c131648e6cfcc6e35da91447d5ab949d6))

## [0.30.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.29.0...v0.30.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **conversations:** `share_id` is no longer accepted on ConversationListParams, ConversationItemListParams or ConversationExportParams. The API already ignored it, so remove it from call sites; reads of shared resources need no parameter.

### Code Refactoring

* **conversations:** drop the share_id read parameter ([#437](https://github.com/introspection-org/introspection-js-sdk/issues/437)) ([664bb91](https://github.com/introspection-org/introspection-js-sdk/commit/664bb91cfe7099ea46892d3baf73197ee53d43f6))

## [0.29.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.28.0...v0.29.0) (2026-10-10)


### Features

* **shares:** tag shares, share update, and ambient share reads ([#434](https://github.com/introspection-org/introspection-js-sdk/issues/434)) ([e470cd3](https://github.com/introspection-org/introspection-js-sdk/commit/e470cd36cc0d6c952dd86d21a0dfee388a1269ff))

## [0.28.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.27.0...v0.28.0) (2026-10-07)


### Features

* **browser:** name the session lane with ?lane= instead of a header ([#432](https://github.com/introspection-org/introspection-js-sdk/issues/432)) ([d8cbd14](https://github.com/introspection-org/introspection-js-sdk/commit/d8cbd1437e3e064b0ed64ae202779f34ee2ede67))

## [0.27.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.26.0...v0.27.0) (2026-10-07)


### Features

* open a runner by Runtime slug without listing; library-specific User-Agent ([#430](https://github.com/introspection-org/introspection-js-sdk/issues/430)) ([ff7d742](https://github.com/introspection-org/introspection-js-sdk/commit/ff7d742abe26d6367062dd42ad307b71bd34fc1a))

## [0.26.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.25.0...v0.26.0) (2026-10-06)


### Features

* **automations:** add automations resource ([#414](https://github.com/introspection-org/introspection-js-sdk/issues/414)) ([6a79121](https://github.com/introspection-org/introspection-js-sdk/commit/6a791213d3053cf8450f32f80054fce3919c27cc))
* **data-plane:** share one Data Plane interface across client and runner; add connections ([#429](https://github.com/introspection-org/introspection-js-sdk/issues/429)) ([3af4864](https://github.com/introspection-org/introspection-js-sdk/commit/3af48642cba026fd95ac5cd2eb859b414c46ebab))
* **files:** accept tags and metadata on file create ([#408](https://github.com/introspection-org/introspection-js-sdk/issues/408)) ([3d357c4](https://github.com/introspection-org/introspection-js-sdk/commit/3d357c400506299bae341970226892b8ccc84061))
* **files:** filter file lists by metadata ([#411](https://github.com/introspection-org/introspection-js-sdk/issues/411)) ([3593f22](https://github.com/introspection-org/introspection-js-sdk/commit/3593f22104f49a520339cb4d068a8982c79e0fb9))
* **members:** add members list/get/create/update with tags and metadata ([#413](https://github.com/introspection-org/introspection-js-sdk/issues/413)) ([0f1ee1e](https://github.com/introspection-org/introspection-js-sdk/commit/0f1ee1e2a82847e4db1f7834fc0f6f93ea5031cd))
* native email-code sign-in, renewing credentials and automations on every Data Plane client ([#412](https://github.com/introspection-org/introspection-js-sdk/issues/412)) ([1910d4e](https://github.com/introspection-org/introspection-js-sdk/commit/1910d4ee30d63b60fcf9d7f18fc86633d481a743))
* **otel:** add logEvent for custom events; track delegates to it ([#428](https://github.com/introspection-org/introspection-js-sdk/issues/428)) ([0f9919f](https://github.com/introspection-org/introspection-js-sdk/commit/0f9919fa764629b1885295ca4ccc819890ed68ad))


### Bug Fixes

* **streaming:** reject incomplete output and resume nonterminal closes ([#410](https://github.com/introspection-org/introspection-js-sdk/issues/410)) ([1a83d78](https://github.com/introspection-org/introspection-js-sdk/commit/1a83d78448f46246cedb1083999b0fbc8a4d0774))

## [0.25.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.24.0...v0.25.0) (2026-09-29)


### Features

* add repository merges ([#406](https://github.com/introspection-org/introspection-js-sdk/issues/406)) ([b1489ce](https://github.com/introspection-org/introspection-js-sdk/commit/b1489cef35308a4ffc41a9187b6eae8d4e6a5a28))
* **connectors:** add custom app search, OAuth discovery and authorize binding ([#405](https://github.com/introspection-org/introspection-js-sdk/issues/405)) ([919aae4](https://github.com/introspection-org/introspection-js-sdk/commit/919aae4d950781e769d12b91f83b4921d0360253))

## [0.24.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.23.0...v0.24.0) (2026-09-24)


### Features

* add repository commits ([#391](https://github.com/introspection-org/introspection-js-sdk/issues/391)) ([3abaa52](https://github.com/introspection-org/introspection-js-sdk/commit/3abaa522b402aec226bde0a9ceab96f6c067799d))
* add repository contents ([#390](https://github.com/introspection-org/introspection-js-sdk/issues/390)) ([a888c5a](https://github.com/introspection-org/introspection-js-sdk/commit/a888c5a5d37ee7923d03e83ac65e7fdcad9f07be))
* **types:** expose the app and account a connection was granted for ([#388](https://github.com/introspection-org/introspection-js-sdk/issues/388)) ([b0cfed8](https://github.com/introspection-org/introspection-js-sdk/commit/b0cfed8ce5ef08f13d33433d2d3bb587a14eda91))


### Bug Fixes

* **pi:** upgrade Pi to 0.87.1 ([#392](https://github.com/introspection-org/introspection-js-sdk/issues/392)) ([9add172](https://github.com/introspection-org/introspection-js-sdk/commit/9add1722d28104eb3efe2d8ad0f366899da2c7c7))

## [0.23.0](https://github.com/introspection-org/introspection-js-sdk/compare/v0.22.0...v0.23.0) (2026-09-02)


### Features

* Add span annotations and project labels client ([#349](https://github.com/introspection-org/introspection-js-sdk/issues/349)) ([8066e76](https://github.com/introspection-org/introspection-js-sdk/commit/8066e76482095662cd461a0e314acce0fc0b41f2))
* **connectors:** support Pipedream app authorization ([#360](https://github.com/introspection-org/introspection-js-sdk/issues/360)) ([24ebde9](https://github.com/introspection-org/introspection-js-sdk/commit/24ebde9212d5b889490cf05cfc412decdb02743b))
* **conversations:** add metadata filter, response field and dict param ([#341](https://github.com/introspection-org/introspection-js-sdk/issues/341)) ([1fda0d3](https://github.com/introspection-org/introspection-js-sdk/commit/1fda0d301b376f51de131dc41be1ed7dd381e2bb))


### Bug Fixes

* expose conversation task titles ([48a0608](https://github.com/introspection-org/introspection-js-sdk/commit/48a06082c9b93499a68518a05f84f9028876f9cd))

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
