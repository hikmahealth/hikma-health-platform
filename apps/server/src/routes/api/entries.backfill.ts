import db from "@/db";
import { createFileRoute } from "@tanstack/react-router";
import { getCookie } from "@tanstack/react-start/server";
import { Option } from "effect";
import Token from "@/models/token";
import User from "@/models/user";
import { uuidv7 } from "uuidv7";
import { readEntriesFromRequest, type SpecialEntry } from "@/imports/a/utils";
import type { DB } from "@hikmahealth/database/types/schema/hh";
import type { InsertObject } from "kysely";
import {
  createTextField,
  createOptionsField,
  createMedicineField,
  type OptionField,
  type TextField,
  type DiagnosisField,
  type DateField,
} from "@/components/forms/fields";

export const Route = createFileRoute("/api/entries/backfill")({
  server: {
    handlers: {
      POST: async function (req) {
        const token = getCookie("token");
        if (!token) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Creates users and clinics, so super_admin only.
        const user = await Token.getUser(token);
        if (Option.isNone(user)) {
          return new Response("Unauthorized", { status: 401 });
        }
        if (user.value.role !== User.ROLES.SUPER_ADMIN) {
          return new Response("Forbidden", { status: 403 });
        }

        if (!req.request.body) {
          return new Response("missing body", { status: 400 });
        }

        // 1. IMPORT PATIENT AND OTHER RELATED RECORDS
        const records = await readEntriesFromRequest(req.request);
        const now = new Date();

        // get the unique keys
        const pkh = new KeymapHasher(patientHash);
        const k = db
          .selectFrom("hh_unique")
          .select(["hh_unique.key", "hh_unique.value"])
          .where("hh_unique.tag", "=", "patient_id")
          .stream();
        for await (let r of k) {
          pkh.keymap.set(r.key, r.value);
        }

        // collect patients
        const [uniquePatients, newmap] = extractUniqueEntries(pkh, records);
        pkh.extend(newmap);

        // create unique keys that'll be used during loading
        // of patient data
        await db.transaction().execute(async (ky) => {
          await ky
            .insertInto("hh_unique")
            .values(
              Array.from(pkh.keymap.entries()).map(([hash, id]) => ({
                tag: "patient_id",
                key: hash,
                value: id,
              })),
            )
            .onConflict((oc) => oc.columns(["tag", "key"]).doNothing())
            .execute();

          await ky
            .insertInto("patients")
            .values(
              uniquePatients.map(({ id, entry }) => ({
                id: id,
                date_of_birth: birthDateFromAge(entry.age, entry.date ?? now),
                sex: entry.gender,
                phone: entry.contact,
              })),
            )
            .execute();
        });

        // 2. get clinic and event_form infromation
        // get the unique key used when backfilling data for spreadsheets.
        // if NA, create one
        const ids = await db
          .insertInto("hh_unique")
          .values([
            {
              tag: "patient_spreadsheet",
              key: "clinic_id",
              value: uuidv7(),
            },
            {
              tag: "patient_spreadsheet",
              key: "event_form_id",
              value: uuidv7(),
            },
          ])
          .returning(["hh_unique.value"])
          .execute();

        const clinicid = ids[0].value;
        const eventformsid = ids[1].value;

        // collect unique doctors,
        // and create their ids
        const ukh = KeymapHasher.fromEntries(practitionerHash, records);
        const [uniquePractitioners, newmappr] = extractUniqueEntries(
          ukh,
          records,
        );
        ukh.extend(newmappr);
        await db
          .insertInto("hh_unique")
          .values(
            Array.from(pkh.keymap.entries()).map(([hash, id]) => ({
              tag: "user_id",
              key: hash,
              value: id,
            })),
          )
          .onConflict((oc) => oc.columns(["tag", "key"]).doNothing())
          .executeTakeFirstOrThrow();

        type FieldDefinition =
          | OptionField
          | TextField
          | DiagnosisField
          | DateField
          | ReturnType<typeof createMedicineField>;

        const form_definition: Partial<
          Record<keyof SpecialEntry, FieldDefinition>
        > = {
          old_new: createOptionsField({
            name: "Old/New",
            inputType: "select",
            options: [
              { value: "old", label: "Old" },
              { value: "new", label: "New" },
            ],
          }),
          diagnosis: createTextField({
            name: "Diagnosis",
          }),
          medicines: createTextField({
            name: "Medicines",
            inputType: "textarea",
            description: "Medicines prescribed during this visit",
          }),
          counseling: createTextField({
            name: "Counseling",
            description: "Counseling notes provided to the patient",
            inputType: "textarea",
          }),
          refer: createTextField({
            name: "Referral",
            description: "Referral details, if any",
            inputType: "textarea",
          }),
          remarks: createTextField({
            name: "Remarks",
            description: "Any additional remarks about the visit",
            inputType: "textarea",
          }),
          venue: createTextField({
            name: "Venue",
            description: "Location where the visit was held",
            inputType: "textarea",
          }),
          area: createTextField({
            name: "Area",
            description: "Area where the visit was held",
            inputType: "textarea",
          }),
        };

        // create unique keys that'll be used during loading
        // of patient data
        await db.transaction().execute(async (ky) => {
          await ky
            .insertInto("clinics")
            .values({
              id: clinicid,
              name: "A", // TODO: might want to pass this in through the request body
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .executeTakeFirstOrThrow();

          await ky
            .insertInto("event_forms")
            .values({
              id: eventformsid,
              name: "patient_spreadsheet_entries", // TODO: same as clinic
              // NOTE: the key of the object, is the `id`
              form_fields: Object.entries(form_definition).map(([id, d]) => ({
                ...d,
                id,
              })),
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .executeTakeFirstOrThrow();

          await ky
            .insertInto("hh_unique")
            .values(
              Array.from(ukh.keymap.entries()).map(([hash, id]) => ({
                tag: "user_id",
                key: hash,
                value: id,
              })),
            )
            .onConflict((oc) => oc.columns(["tag", "key"]).doNothing())
            .execute();

          await ky
            .insertInto("users")
            .values(
              uniquePractitioners.map(({ id, entry }) => ({
                id: id,
                name: entry.doctor ?? "",
                role: "provider",
                email: `a.${(entry.doctor ?? "doctor").trim()}@test.com`,
                hashed_password: "secret",
                clinic_id: clinicid,
              })),
            )
            .onConflict((oc) => oc.columns(["id"]).doNothing())
            .onConflict((oc) =>
              oc
                .columns(["email"])
                .doUpdateSet({ email: uuidv7() + ".a@test.com" }),
            )
            .execute();
        });

        // for A, it's a single clinic, that's moving to different locations.
        // use the same "one", clinic record, but have the location information within the events_form

        const tx = await db
          .startTransaction()
          .setIsolationLevel("read committed")
          .execute();
        try {
          const visits: InsertObject<DB, "visits">[] = [];
          const events: InsertObject<DB, "events">[] = [];
          const vitals: InsertObject<DB, "patient_vitals">[] = [];

          for (let ix = 0; ix <= records.length; ix++) {
            let e = records[ix];
            let visit = {
              id: uuidv7(),
              patient_id: pkh.getIdFromHash(e) as string,
              provider_id: ukh.getIdFromHash(e) as string,
              provider_name: e.area,
              check_in_timestamp: e.date,
            };
            visits.push(visit);

            let event = {
              id: uuidv7(),
            };

            events.push({
              ...event,
              recorded_by_user_id: visit.provider_id,
              patient_id: visit.patient_id,
              visit_id: visit.id,
              created_at: e.date,
              updated_at: e.date,
              form_data: Object.entries(form_definition)
                .map(([k, field]) => {
                  if (e[k] === undefined) return null;
                  return {
                    name: field.name,
                    value: e[k],
                    fieldId: field.id,
                    fieldType: field.fieldType,
                  };
                })
                .filter((x) => x !== null),
            });

            vitals.push({
              id: uuidv7(),
              patient_id: visit.patient_id,
              recorded_by_user_id: visit.provider_id,
              visit_id: visit.id,
              timestamp: e.date ?? now,
              height_cm: e.height,
              weight_kg: e.weight,
            });
          }

          await tx.insertInto("visits").values(visits).execute();
          await tx.insertInto("events").values(events).execute();
          await tx.insertInto("patient_vitals").values(vitals).execute();

          tx.commit().execute();
        } catch (err) {
          await tx.rollback().execute();
          throw err;
        }

        // to create the form, visits and associated events
        // - this "load_from_csv" operation, can be through of as a single "form", that add data.
        //  we can call this "form", patient_spreadsheet_entry
        // - each record is:
        //    * a visit (regardless of weather or not they are happening on the same date)
        //    * an event, in the event form

        return new Response("okeee", { status: 200 });
      },
    },
  },
});

// create unique patient hash
function patientHash(entry: SpecialEntry) {
  let hashinput = entry.name.toLowerCase().trim();
  hashinput += "." + entry.gender;
  hashinput += "." + entry.old_new;
  hashinput += entry.age.toString();
  return hashinput;
}

function practitionerHash(entry: SpecialEntry) {
  let hashinput = entry.doctor?.trim?.() ?? entry.venue.trim();
  hashinput += "." + entry.venue.trim();
  return hashinput;
}

function extractUniqueEntries<T>(kmh: KeymapHasher<T>, entries: Array<T>) {
  const seen = new Set();
  const uniqueEntries = [];
  const m = new Map(kmh.keymap);
  let e;
  for (let i = 0; i < entries.length; i++) {
    e = entries[i];

    const key = kmh.hashEntry(e);
    let id = m.get(key) ?? null;

    if (id === null) {
      id = uuidv7();
      m.set(kmh.hashEntry(e), id);
      uniqueEntries.push({
        index: i,
        id,
        entry: e,
      });
      seen.add(id);
      continue;
    }

    if (!seen.has(id)) {
      uniqueEntries.push({
        index: i,
        id,
        entry: e,
      });
      seen.add(id);
    }
  }

  return [uniqueEntries, m] as const;
}

class KeymapHasher<T> {
  #map: Map<string, string>;
  #hashFn: (v: T) => string;
  constructor(
    hashFunction: (v: T) => string,
    input?: Iterable<[string, string]> | Map<string, string>,
  ) {
    this.#map = new Map(input ?? []);
    this.#hashFn = hashFunction;
  }

  extend(input: Iterable<[string, string]> | Map<string, string>) {
    const p = new Map(input ?? []);
    for (let [k, v] of p.entries()) {
      if (!this.#map.has(k)) {
        this.#map.set(k, v);
      }
    }
  }

  get keymap() {
    return this.#map;
  }

  getIdFromHash(entry: T) {
    return this.#map.get(this.#hashFn(entry)) ?? null;
  }

  hashEntry(entry: T) {
    return this.#hashFn(entry);
  }

  static fromEntries<T>(hash: (v: T) => string, entries: Iterable<T>) {
    const keymap = new Map<string, string>();
    for (let e of entries) {
      const key = hash(e);
      let id = keymap.get(key);
      if (id === null) {
        id = uuidv7();
        keymap.set(key, id);
      }
    }

    return new KeymapHasher(hash, keymap);
  }
}

/**
 *
 * @param age age of person in days
 * @param referenceDate the date from which to calculate the age
 * @returns approximate birth date string in YYYY/MM/DD format
 */
function birthDateFromAge(age: number, referenceDate: Date): string {
  const refYear = referenceDate.getFullYear();
  const refMonth = referenceDate.getMonth() + 1;
  const refDay = referenceDate.getDate();

  const totalDays = age;
  const years = Math.floor(totalDays / 365);
  const remainingDaysAfterYears = totalDays % 365;
  const months = Math.floor(remainingDaysAfterYears / 30);
  const days = remainingDaysAfterYears % 30;

  let birthYear = refYear - years;
  let birthMonth = refMonth - months;
  let birthDay = refDay - days;

  if (birthDay < 1) {
    birthMonth -= 1;
    birthDay += 30;
  }

  if (birthMonth < 1) {
    birthYear -= 1;
    birthMonth += 12;
  }

  const yyyy = birthYear.toString().padStart(4, "0");
  const mm = birthMonth.toString().padStart(2, "0");
  const dd = birthDay.toString().padStart(2, "0");

  return `${yyyy}/${mm}/${dd}`;
}

// Looking at how the information is going to be loaded to the database
//
// 1. create list of patients from the list, there can be some formular we create to determine uniqueness of user
// 2. create list of users (practitioners) from the list, here, we can also include a uniqueness function to use
// 3. create `patient_entry` events, to represent the entries that are put by the practitioners
//
// HOW?
// 1. insertinto patients
// 2. insertinto users (as practitioners, example "Dr. Monika")
// 3. create clinic (called BUDS)
// 4. create visit (backfill_visit) (might want to use this to indicate backfill properties)
// 5. create event_form called "backfill"
// 6. create events, with the `event_type=data_entry`
//
