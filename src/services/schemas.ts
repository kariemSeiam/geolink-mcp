import { z } from "zod";
import { BoundsSchema, LatLngSchema } from "./resolve.js";

export const AddressPartsSchema = z.object({
  district: z.string(),
  governorate: z.string(),
  country: z.string(),
});

export const PlaceSchema = z.object({
  name: z.string(),
  address: z.string(),
  address_parts: AddressPartsSchema,
  location: LatLngSchema,
  bounds: BoundsSchema.optional(),
});

export const ResolvedLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  input: z.string(),
  label: z.string(),
  source: z.enum(["coordinates", "geocode"]),
});

export const RouteEndpointSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  name: z.string(),
  address: z.string(),
});

export const MatrixCellSchema = z.object({
  distance_meters: z.number(),
  distance_text: z.string(),
  duration_seconds: z.number(),
  duration_text: z.string(),
});

export const PaginationFields = {
  total: z.number().int(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  truncated: z.boolean().optional(),
  truncation_message: z.string().optional(),
};
