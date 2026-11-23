import * as questionBank from "./question-bank/index.ts";
import * as subject from "./subject/index.ts";

/** The fakes the Recipe binds. */
export const recipeFakes = { "question-bank": questionBank };
/** Every fake, including the trivia master's voice for simulated series. */
export const fakes = { ...recipeFakes, subject };
