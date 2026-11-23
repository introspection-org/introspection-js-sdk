import {
  type McpServer,
  text,
  toolsOf,
} from "@introspection-ai/eval-simulate/mcp";
import { contract } from "./contract.ts";
import type { State } from "./entities.ts";
import { questionsIn, REGION_LABEL } from "../../scenarios/bank.ts";
import { NIGHTS, PER_ROUND, ROUNDS, teamAnswer } from "../../venues.ts";

const { config } = toolsOf(contract);
const list = (xs: string[]) =>
  xs.length <= 1
    ? xs.join("")
    : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

export function register(server: McpServer, state: State) {
  server.registerTool("say", config("say"), async ({ text: message }) => {
    const v = state.venue;
    if (!v) return text("No venue in this scenario.", true);
    const night = state.nights.at(-1);

    // An empty message starts the next night.
    if (message.trim() === "") {
      if (night && !night.ended) return text("We're still mid-quiz! Carry on.");
      if (state.nights.length >= NIGHTS)
        return text("That's the season done. Thanks!");
      const n = state.nights.length + 1;
      state.nights.push({ night: n, rounds: [], ended: false });
      const fmt = `${ROUNDS} rounds of ${PER_ROUND} tonight.`;
      if (n === 1)
        return text(
          `Evening! I run the quiz at ${v.name}, in ${REGION_LABEL[v.region]}. Our lot are mostly into ${list(v.stated)}. ${fmt} Over to you.`,
        );
      const req = v.request?.night === n ? ` ${v.request.text}` : "";
      return text(
        `Evening! Quiz night again at ${v.name}. ${fmt}${req} Over to you.`,
      );
    }
    if (!night) return text("Hang on, we haven't started yet.", true);
    if (night.ended)
      return text("We're all done for tonight, thanks! Goodnight.");

    const heard = new Set(night.rounds.flatMap((r) => r.question_ids));
    const fresh = questionsIn(message).filter((q) => !heard.has(q.id));
    if (fresh.length === 0) {
      if (night.rounds.length >= ROUNDS) {
        night.ended = true;
        return text(
          "That's the night! Great stuff, thanks. Same time next week.",
        );
      }
      if (night.rounds.length === 0)
        return text(
          "Sounds good. Send the first round's questions when you're ready.",
        );
      return text("Got it, thanks! Ready for the next round when you are.");
    }
    if (night.rounds.length >= ROUNDS)
      return text(
        `We only do ${ROUNDS} rounds here, so that's us done. Wrap it up for us?`,
      );

    const lines: string[] = [];
    const correct = fresh.map(() => 0);
    for (const team of v.teams) {
      const answers = fresh.map((q, i) => {
        const a = teamAnswer(state.seed, v, night.night, team, q);
        if (a.right) correct[i]++;
        return `${i + 1}. ${a.text}`;
      });
      lines.push(`${team.name}: ${answers.join("; ")}`);
    }
    night.rounds.push({
      question_ids: fresh.map((q) => q.id),
      correct,
      teams: v.teams.length,
    });

    const grumbles: string[] = [];
    const foreign = fresh.filter(
      (q) => q.region !== "general" && q.region !== v.region,
    );
    if (foreign.length)
      grumbles.push(
        `A few groans: nobody here had a clue about the ones meant for ${list([...new Set(foreign.map((q) => REGION_LABEL[q.region]))])}.`,
      );
    const flops = v.disliked.filter(
      (g) => fresh.filter((q) => q.genre === g).length >= 2,
    );
    if (flops.length)
      grumbles.push(`The room went quiet for the ${list(flops)} questions.`);
    return text(
      `Round's in. ${v.teams.length} teams, answers in question order:\n${lines.join("\n")}` +
        (grumbles.length ? `\n\n${grumbles.join(" ")}` : ""),
    );
  });
}
