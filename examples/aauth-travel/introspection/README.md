# Introspection inputs

What `pnpm run introspection:setup` creates in your project, as the request
documents the `introspection` CLI sends. Edit them to change the demo.

- `booking.json`: the booking provider as an AAuth connector
  (`introspection connectors create @booking.json`). The setup adds what
  depends on your stack: the Person Server, the application the agent acts as,
  and the provider's public URL. `policy_entities` are the companies the
  recipe's Cedar rails read: the least seniority that may fly business.
- `sam.json`: Sam, the traveller, as a customer member
  (`introspection members create @sam.json`). His `policy_attributes` are the
  `Person` the rails read, in the shape the recipe's
  `policies/schema.cedarschema` declares: `level` is a Cedar `Long`, `company`
  references a `Company` entity above. A value the schema does not declare is
  not refused here; it makes the egress deny Sam's bookings.
