/**
 * The 27 governorates of Egypt, in both scripts.
 *
 * Recovered from the deployed 1.0.0 server, which served this resource while
 * the repository had lost it. It earns its place for a reason the tool
 * descriptions cannot: an agent asked for "all pharmacies in Egypt" has no way
 * to enumerate the administrative units it would have to sweep, and guessing
 * transliterations produces geocode misses that look like empty regions rather
 * than like spelling errors.
 *
 * Both spellings matter. `address_parts.governorate` comes back in the language
 * the request asked for, so grouping results across mixed-language calls needs
 * the pairing to match them up.
 */

export interface Governorate {
  en: string;
  ar: string;
}

export const EGYPT_GOVERNORATES: readonly Governorate[] = [
  { en: "Cairo", ar: "القاهرة" },
  { en: "Giza", ar: "الجيزة" },
  { en: "Alexandria", ar: "الإسكندرية" },
  { en: "Qalyubia", ar: "القليوبية" },
  { en: "Dakahlia", ar: "الدقهلية" },
  { en: "Sharqia", ar: "الشرقية" },
  { en: "Gharbia", ar: "الغربية" },
  { en: "Menofia", ar: "المنوفية" },
  { en: "Beheira", ar: "البحيرة" },
  { en: "Kafr El Sheikh", ar: "كفر الشيخ" },
  { en: "Damietta", ar: "دمياط" },
  { en: "Port Said", ar: "بورسعيد" },
  { en: "Ismailia", ar: "الإسماعيلية" },
  { en: "Suez", ar: "السويس" },
  { en: "North Sinai", ar: "شمال سيناء" },
  { en: "South Sinai", ar: "جنوب سيناء" },
  { en: "Red Sea", ar: "البحر الأحمر" },
  { en: "Matrouh", ar: "مطروح" },
  { en: "New Valley", ar: "الوادي الجديد" },
  { en: "Fayoum", ar: "الفيوم" },
  { en: "Beni Suef", ar: "بني سويف" },
  { en: "Minya", ar: "المنيا" },
  { en: "Assiut", ar: "أسيوط" },
  { en: "Sohag", ar: "سوهاج" },
  { en: "Qena", ar: "قنا" },
  { en: "Luxor", ar: "الأقصر" },
  { en: "Aswan", ar: "أسوان" },
] as const;
