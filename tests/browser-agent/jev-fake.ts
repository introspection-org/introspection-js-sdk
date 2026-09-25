/**
 * A scripted TypeSafe endpoint for driver tests. It answers every question in
 * the request it receives with a coherent distribution over exactly the ids
 * offered — what JevDriver now requires before it acts — choosing `choices[q]`
 * where given and the first offered id otherwise.
 */
export interface FakeJev {
  fetch: typeof globalThis.fetch;
  bodies: {
    questions: Record<string, { criteria: Record<string, unknown> }>;
    state: {
      recent_actions: { op: string; page_changed?: boolean }[];
      elements: unknown[];
    };
  }[];
}

export function fakeJev(choices: Record<string, string> = {}): FakeJev {
  const bodies: FakeJev["bodies"] = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as FakeJev["bodies"][number];
    bodies.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([name, question]) => {
        const ids = Object.keys(question.criteria);
        const choice = choices[name] ?? ids[0]!;
        return [
          name,
          {
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              ids.map((id) => [id, id === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    );
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers,
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}
