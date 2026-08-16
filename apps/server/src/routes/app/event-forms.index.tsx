import {
  createFileRoute,
  getRouteApi,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import EventForm from "@/models/event-form";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { getEventForms } from "@/lib/server-functions/event-forms";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { Result } from "@/lib/result";
import { Logger } from "@hikmahealth/js-utils";
import { superAdminMiddleware } from "@/middleware/auth";
import {
  COPY_NAME_SUFFIX,
  duplicateFormContent,
} from "@/lib/duplicate-event-form";
import { safeJSONParse } from "@/lib/utils";
import { truncate } from "es-toolkit/compat";

const deleteForm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    return EventForm.API.softDelete(data.id);
  });

const duplicateForm = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    const source = await EventForm.API.getById(data.id);
    if (!source) {
      throw new Error("Form not found");
    }

    // Legacy rows store `form_fields` as a JSON string, and `getById` hands
    // the column through as-is.
    const content = duplicateFormContent({
      form_fields: safeJSONParse(
        source.form_fields,
        [] as Record<string, unknown>[],
      ),
      translations: safeJSONParse(
        source.translations,
        [] as EventForm.FieldTranslation[],
      ),
    });

    // Only the authored columns: `insert` mints the id and stamps every
    // timestamp itself, which is what the cast covers.
    const created = await EventForm.API.insert({
      name: `${source.name || "Untitled form"}${COPY_NAME_SUFFIX}`,
      description: source.description,
      language: source.language,
      is_editable: source.is_editable,
      is_snapshot_form: source.is_snapshot_form,
      metadata: source.metadata,
      clinic_ids: source.clinic_ids,
      form_fields: content.form_fields,
      translations: content.translations,
      is_deleted: false,
    } as unknown as EventForm.EncodedT);

    return { id: created.id };
  });

const toggleFormDetail = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { id: string; field: "snapshot" | "editable"; value: boolean }) => d,
  )
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    switch (data.field) {
      case "snapshot":
        return await EventForm.API.toggleSnapshot({
          id: data.id,
          isSnapshot: data.value,
        });
      case "editable":
        return await EventForm.API.toggleEditable({
          id: data.id,
          isEditable: data.value,
        });
      default:
        throw Error("Unknown field");
    }
  });

export const Route = createFileRoute("/app/event-forms/")({
  component: RouteComponent,
  loader: async () => {
    const [forms, clinics] = await Promise.all([
      getEventForms({ data: { includeDeleted: false } }),
      getAllClinics().then((r) => Result.getOrElse(r, [])),
    ]);
    return { forms, clinics };
  },
});

function RouteComponent() {
  const { forms, clinics } = Route.useLoaderData();
  const route = useRouter();
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const clinicMap = new Map(clinics.map((c) => [c.id, c.name]));

  const handleSnapshotToggle = (id: string, isSnapshot: boolean) => {
    toggleFormDetail({ data: { id, field: "snapshot", value: isSnapshot } })
      .then(() => {
        toast.success("Form snapshot mode toggled successfully");
        route.invalidate({ sync: true });
      })
      .catch((error) => {
        toast.error("Failed to toggle form snapshot mode");
        Logger.error(error);
      });
  };

  const handleEditableToggle = (id: string, isEditable: boolean) => {
    toggleFormDetail({ data: { id, field: "editable", value: isEditable } })
      .then(() => {
        toast.success("Form editable mode toggled successfully");
        route.invalidate({ sync: true });
      })
      .catch((error) => {
        toast.error("Failed to toggle form editable mode");
        Logger.error(error);
      });
  };

  const handleDuplicate = (id: string) => {
    setDuplicatingId(id);
    duplicateForm({ data: { id } })
      .then(() => {
        toast.success("Form duplicated successfully");
        route.invalidate({ sync: true });
      })
      .catch((error) => {
        // `insert` re-validates the source's rules, so a form the admin never
        // touched can fail here and the breakdown is all they have to go on.
        const reason: unknown = error?.message;
        toast.error(
          typeof reason === "string" && reason.length > 0
            ? `Failed to duplicate form: ${reason}`
            : "Failed to duplicate form",
        );
        Logger.error(error);
      })
      .finally(() => setDuplicatingId(null));
  };

  const handleDelete = (id: string) => {
    if (!window.confirm("Are you sure you want to delete this form?")) {
      return;
    }

    deleteForm({ data: { id } })
      .then(() => {
        toast.success("Form deleted successfully");
        route.invalidate({ sync: true });
      })
      .catch((error) => {
        toast.error("Failed to delete form");
        Logger.error(error);
      });
  };

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Event Forms</h1>
        <Link to="/app/event-forms/edit/$" params={{ _splat: "new" }}>
          <Button>Create New Form</Button>
        </Link>
      </div>

      <div className="rounded-md border overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableCaption>Event Forms</TableCaption>
            <TableHeader>
              <TableRow>
                {/*<TableHead>Snapshot</TableHead>*/}
                <TableHead>Editable</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Clinics</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center">
                    No forms available
                  </TableCell>
                </TableRow>
              ) : (
                forms.map((form) => (
                  <TableRow key={form.id}>
                    {/*<TableCell>
                      <Checkbox
                        checked={form.is_snapshot_form}
                        onCheckedChange={() =>
                          handleSnapshotToggle(form.id, !form.is_snapshot_form)
                        }
                      />
                    </TableCell>*/}
                    <TableCell>
                      <Checkbox
                        checked={form.is_editable}
                        onCheckedChange={() =>
                          handleEditableToggle(form.id, !form.is_editable)
                        }
                      />
                    </TableCell>
                    <TableCell>{form.name || "—"}</TableCell>
                    <TableCell>{truncate(form.description || "—", { length: 72 })}</TableCell>
                    <TableCell>
                      {!form.clinic_ids || form.clinic_ids.length === 0
                        ? "All"
                        : form.clinic_ids.slice(0, 5)
                            .map((id) => clinicMap.get(id) ?? id)
                            .join(", ")}
                    </TableCell>
                    <TableCell>
                      {format(form.created_at, "yyyy-MM-dd")}
                    </TableCell>
                    <TableCell>
                      {format(form.updated_at, "yyyy-MM-dd")}
                    </TableCell>
                    <TableCell className="space-x-2">
                      <Link
                        to="/app/event-forms/edit/$"
                        params={{ _splat: form.id }}
                      >
                        <Button variant="outline" size="sm">
                          Edit
                        </Button>
                      </Link>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={duplicatingId === form.id}
                        onClick={() => handleDuplicate(form.id)}
                      >
                        {duplicatingId === form.id
                          ? "Duplicating…"
                          : "Duplicate"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(form.id)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
