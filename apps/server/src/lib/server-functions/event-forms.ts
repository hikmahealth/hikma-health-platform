import { createServerFn } from "@tanstack/react-start";
import EventForm from "@/models/event-form";
import { safeJSONParse } from "../utils";
import { adminMiddleware } from "@/middleware/auth";

export const getEventForms = createServerFn({ method: "GET" })
  .validator((data: { includeDeleted?: boolean } = {}) => data)
  .middleware([adminMiddleware])
  .handler(
    async ({
      data,
    }: {
      data?: { includeDeleted?: boolean };
    }): Promise<EventForm.EncodedT[]> => {
      const result = await EventForm.API.getAll(data);

      // For some users migrating from old old version, where the "form_fields" is a JSON string;
      return result.map((form) => {
        const formFields = (() => {
          let data;
          if (typeof form.form_fields === "string") {
            data = safeJSONParse(form.form_fields, []);
            // Hand the raw string back rather than [] so the client gets one
            // more chance to salvage it.
            if (data.length === 0) {
              data = form.form_fields;
            }
          } else {
            data = form.form_fields;
          }

          // Normalise fields written by older versions.
          if (Array.isArray(data)) {
            data.forEach((field) => {
              // migrate text area to text input with long length
              if (field.inputType === "textarea") {
                field.inputType = "text";
                field.length = "long";
              }
              field._tag = EventForm.getFieldTag(field.fieldType);
            });
          }

          return data;
        })();

        return {
          ...form,
          form_fields: formFields,
        };
      });
    },
  );
