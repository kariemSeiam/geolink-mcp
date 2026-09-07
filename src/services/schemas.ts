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

/**
 * A place as x describes one. Every key is always present; null means the
 * place genuinely has no such thing, which is why none of these is `.optional()`
 * — an absent key and a null one would say different things, and only one of
 * them is ever true here.
 */
export const XPlaceSchema = z.object({
  name: z.string(),
  place_id: z.string().nullable(),
  short_address: z.string(),
  address: z.string().nullable(),
  address_parts: AddressPartsSchema,
  location: LatLngSchema,
  category: z.string().nullable(),
  type: z.string().nullable(),
  /** Never a bare average: the count it rests on travels with it, or neither does. */
  rating: z.object({ value: z.number(), count: z.number().int() }).nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  photo: z.string().nullable(),
  hours: z
    .object({
      today: z.string().optional(),
      status: z.string().optional(),
      open_now: z.boolean().optional(),
    })
    .nullable(),
  timezone: z.string().nullable(),
  distance_m: z.number().nullable(),
});

/** What a place named in words turned out to be. */
export const XNearSchema = z.object({
  short_address: z.string().nullable(),
  address: z.string().nullable(),
  address_parts: AddressPartsSchema,
  location: LatLngSchema,
});
