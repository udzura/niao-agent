import {z} from "zod";
export const locationInput = z.strictObject({
  query: z.string().trim().min(2).max(120),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform(value => value.toUpperCase()).optional(),
});
export const forecastInput = z.strictObject({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  days: z.number().int().min(1).max(7).default(3),
});
export type LocationInput = z.input<typeof locationInput>;
export type ForecastInput = z.input<typeof forecastInput>;
export const kaniUrl = z.string().max(200).regex(/^https:\/\/yota\.kani\.show\/e[0-9]{1,12}(?:\/(?:index\.md)?)?$/);
export const kaniArticleInput = z.strictObject({url:kaniUrl,offset:z.number().int().min(0).max(262144).default(0)});
export const kaniLatestInput = z.strictObject({includeArticle:z.boolean().default(true)});
export const kaniSearchInput = z.strictObject({query:z.string().trim().min(1).max(200),limit:z.number().int().min(1).max(20).default(5)});
export const webFetchInput = z.strictObject({url:z.string().trim().min(1).max(2048)});
export type WebFetchInput = z.input<typeof webFetchInput>;
