# Changelog

## [0.12.1](https://github.com/introspection-org/introspection-js-sdk/compare/v0.12.0...v0.12.1) (2026-07-24)


### Bug Fixes

* **deps:** align all @earendil-works/pi-* to 0.80.10 (unblock release build) ([#241](https://github.com/introspection-org/introspection-js-sdk/issues/241)) ([2856d41](https://github.com/introspection-org/introspection-js-sdk/commit/2856d41e78ffbb862493545eba07be056f35da54))

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
