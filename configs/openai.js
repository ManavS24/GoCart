import OpenAI from "openai";

// Per call, not at module load: the SDK throws on an unset key, which a
// module-scope client would turn into a `next build` failure.
export const getOpenAI = () => new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
