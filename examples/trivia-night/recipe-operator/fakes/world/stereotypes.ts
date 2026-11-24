// The two genres a host would guess a crowd loves from its city's name alone. A venue's crowd is
// redrawn while its two favourites overlap these (profiles.ts `derive`), so a host can't guess
// them from the city; evals/stereotype-check.mjs reports the overlap before and after.
import type { Genre } from "../mcp/trivia-bank/entities.ts";

export const STEREOTYPES: Record<string, [Genre, Genre]> = {
  // Development pubs.
  Sydney: ["sport", "geography"],
  Manchester: ["music", "sport"],
  Chicago: ["sport", "music"],
  Leeds: ["sport", "history"],
  Melbourne: ["sport", "film"],
  Boston: ["history", "sport"],
  Bristol: ["music", "film"],
  Brisbane: ["sport", "geography"],
  Seattle: ["music", "science"],
  Glasgow: ["sport", "history"],
  Perth: ["sport", "geography"],
  // Held-out pubs.
  Adelaide: ["sport", "history"],
  Hobart: ["geography", "history"],
  Darwin: ["geography", "sport"],
  Canberra: ["history", "science"],
  Newcastle: ["sport", "music"],
  Geelong: ["sport", "geography"],
  Cairns: ["geography", "science"],
  Liverpool: ["music", "sport"],
  Birmingham: ["history", "music"],
  Edinburgh: ["history", "film"],
  Cardiff: ["sport", "music"],
  Nottingham: ["history", "sport"],
  Sheffield: ["music", "sport"],
  Belfast: ["history", "film"],
  Denver: ["sport", "geography"],
  Austin: ["music", "film"],
  Portland: ["music", "geography"],
  Atlanta: ["music", "history"],
  Nashville: ["music", "history"],
  Minneapolis: ["sport", "music"],
};

/** Draws of a venue's crowd before the least-stereotyped one so far is kept. */
export const MAX_DRAWS = 16;
