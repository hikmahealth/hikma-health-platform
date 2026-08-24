import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronLeft, LucideGripHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { superAdminMiddleware } from "@/middleware/auth";
import AppConfig from "@/models/app-config";
import {
  DEFAULT_PATIENT_VIEW_ACTIONS,
  PATIENT_VIEW_ACTIONS,
  PATIENT_VIEW_ACTIONS_KEY,
  PATIENT_VIEW_ACTIONS_NAMESPACE,
  canonicalizePatientViewActions,
  type PatientViewActionEntry,
} from "@/lib/patient-view-actions";

const getPatientViewActions = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async (): Promise<PatientViewActionEntry[]> => {
    const row = await AppConfig.API.get(
      PATIENT_VIEW_ACTIONS_NAMESPACE,
      PATIENT_VIEW_ACTIONS_KEY,
    );
    // A missing or unusable row canonicalizes to every action visible in
    // registry order, which is the default — no separate fallback needed.
    return canonicalizePatientViewActions(
      row ? AppConfig.Utils.parseValue(row) : null,
    );
  });

const savePatientViewActions = createServerFn({ method: "POST" })
  .validator((data: { entries: unknown }) => data)
  .middleware([superAdminMiddleware])
  .handler(async ({ data, context }) => {
    // The request body is untrusted; canonicalization is the validation, and it
    // is total, so a malformed body stores the defaults rather than throwing.
    const entries = canonicalizePatientViewActions(data.entries);

    // Never DELETE the row to "reset": app_config has no tombstones, so a
    // deleted row is invisible to sync and devices keep the stale value.
    return await AppConfig.API.set(
      PATIENT_VIEW_ACTIONS_NAMESPACE,
      PATIENT_VIEW_ACTIONS_KEY,
      "Patient View Actions",
      entries,
      "array",
      context.userId,
      // Explicit because this screen owns the row's scope. null = all clinics.
      null,
    );
  });

export const Route = createFileRoute("/app/settings/configurations/patient-view-actions")({
  component: RouteComponent,
  loader: async () => ({ entries: await getPatientViewActions() }),
});

function RouteComponent() {
  const { entries: loaded } = Route.useLoaderData();
  const router = useRouter();
  const [entries, setEntries] = useState<PatientViewActionEntry[]>(loaded);
  const [isSaving, setIsSaving] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEntries((current) => {
      const from = current.findIndex((e) => e.id === active.id);
      const to = current.findIndex((e) => e.id === over.id);
      if (from === -1 || to === -1) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const toggleVisible = (id: string) => {
    setEntries((current) =>
      current.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)),
    );
  };

  const save = async () => {
    setIsSaving(true);
    try {
      await savePatientViewActions({ data: { entries } });
      toast.success("Patient view actions saved");
      router.invalidate();
    } catch {
      toast.error("Could not save patient view actions");
    } finally {
      setIsSaving(false);
    }
  };

  const resetToDefault = () => setEntries([...DEFAULT_PATIENT_VIEW_ACTIONS]);

  const labelOf = (id: string) =>
    PATIENT_VIEW_ACTIONS.find((a) => a.id === id)?.label ?? id;
  const descriptionOf = (id: string) =>
    PATIENT_VIEW_ACTIONS.find((a) => a.id === id)?.description ?? "";

  return (
    <div className="p-4 max-w-2xl">
      {/* This page is reached from Configurations, not the sidebar, so it
          carries its own way back. */}
      <Link
        to="/app/settings/configurations"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ChevronLeft className="h-4 w-4" />
        Configurations
      </Link>

      <h1 className="text-xl font-semibold">Patient View Actions</h1>
      <p className="text-sm text-muted-foreground pt-1 pb-6">
        Drag to reorder the action rows clinicians see on a patient&apos;s file
        in the mobile app, and untick any you want hidden. Changes reach devices
        on their next sync.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={entries.map((e) => e.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-3">
            {entries.map((entry) => (
              <SortableItem id={entry.id} key={entry.id}>
                <div
                  className="p-4 bg-muted/50 rounded-lg border flex items-center gap-3"
                  data-testid="patient-view-action-row"
                >
                  <Checkbox
                    checked={entry.visible}
                    onCheckedChange={() => toggleVisible(entry.id)}
                    aria-label={`Show ${labelOf(entry.id)}`}
                  />
                  <div>
                    <div className="font-medium">{labelOf(entry.id)}</div>
                    <div className="text-sm text-muted-foreground">
                      {descriptionOf(entry.id)}
                    </div>
                  </div>
                </div>
              </SortableItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex gap-2 pt-6">
        <Button onClick={save} disabled={isSaving}>
          {isSaving ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" onClick={resetToDefault} disabled={isSaving}>
          Reset to default
        </Button>
      </div>
    </div>
  );
}

function SortableItem({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div
        {...listeners}
        className="flex items-center content-center justify-center cursor-move -mb-2"
      >
        <LucideGripHorizontal
          className="text-muted-foreground self-center"
          color="var(--foreground)"
          size="1rem"
        />
      </div>
      {children}
    </div>
  );
}
