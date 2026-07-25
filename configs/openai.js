import OpenAI from "openai";

// Constructed per call, not at module load. The SDK throws when OPENAI_API_KEY
// is unset, and a module-scope client turns that into a `next build` failure
// even though AI descriptions are an optional feature.
export const getOpenAI = () => new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
