import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  LucideSave,
  LucideGlobe,
  LucideLock,
  LucideEye,
  LucideUpload,
} from "lucide-react";
import CreatableSelect from "react-select/creatable";
import db from "@/db";
import { sql } from "kysely";
import { getConfiguredAdapter } from "@/storage/factory";
import { putVerified } from "@/storage/integrity";
import {
  EDUCATION_RESOURCE_PATH_PREFIX,
  UPLOAD_SIZE_LIMIT_BYTES,
  isAllowedMimetype,
  sanitizeFilename,
} from "@/storage/types";
import { sha256Hex } from "@/lib/form-resources";
import { v7 as uuidV7 } from "uuid";
import { TipTapEditor } from "@/components/education/tiptap-editor";
import { getCurrentUserId } from "@/lib/server-functions/auth";
import type EducationContent from "@/models/education-content";
import { adminMiddleware } from "@/middleware/auth";

type ContentRow = EducationContent.Serialized;

// ── Server Functions ──────────────────────────────────────────────────

const getContentById = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<ContentRow | null> => {
    const row = await db
      .selectFrom("education_content")
      .selectAll()
      .where("id", "=", data.id)
      .where("is_deleted", "=", false)
      .executeTakeFirst();
    return (row as unknown as ContentRow) ?? null;
  });

const saveContent = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      id: string | null;
      title: string;
      description: string | null;
      content_type: "tiptap" | "resource";
      tiptap_content: Record<string, unknown> | null;
      resource_id: string | null;
      status: "draft" | "published";
      visibility: "public" | "private";
      language: string;
      tags: string[];
      metadata: Record<string, unknown>;
    }) => data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<ContentRow> => {
    const { id, ...fields } = data;
    const publishedAt =
      fields.status === "published" ? new Date().toISOString() : null;
    const authorId = await getCurrentUserId();

    if (id) {
      const updateData: Record<string, unknown> = {
        ...fields,
        tiptap_content: fields.tiptap_content
          ? JSON.stringify(fields.tiptap_content)
          : null,
        resource_id: fields.resource_id ?? null,
        tags: JSON.stringify(fields.tags),
        metadata: JSON.stringify(fields.metadata),
        updated_at: sql`now()`,
      };
      if (fields.status === "published") {
        const existing = await db
          .selectFrom("education_content")
          .select("published_at")
          .where("id", "=", id)
          .executeTakeFirst();
        if (!existing?.published_at) {
          updateData.published_at = publishedAt;
        }
      }
      const row = await db
        .updateTable("education_content")
        .set(updateData as any)
        .where("id", "=", id)
        .where("is_deleted", "=", false)
        .returningAll()
        .executeTakeFirstOrThrow();
      return row as unknown as ContentRow;
    }

    const row = await db
      .insertInto("education_content")
      .values({
        title: fields.title,
        description: fields.description,
        content_type: fields.content_type,
        tiptap_content: fields.tiptap_content
          ? JSON.stringify(fields.tiptap_content)
          : null,
        resource_id: fields.resource_id,
        status: fields.status,
        visibility: fields.visibility,
        language: fields.language,
        tags: JSON.stringify(fields.tags),
        metadata: JSON.stringify(fields.metadata),
        author_id: authorId ?? null,
        published_at: publishedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as ContentRow;
  });

/** Upload a file and create a Resource entry. Returns the resource row. */
const uploadFile = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { fileName: string; mimetype: string; fileBase64: string }) => data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<{ id: string }> => {
    // Validate mimetype server-side before storing — client-supplied values are untrusted
    if (!isAllowedMimetype(data.mimetype)) {
      throw new Error(`File type not allowed: ${data.mimetype}`);
    }

    const bytes = Uint8Array.from(atob(data.fileBase64), (c) =>
      c.charCodeAt(0),
    );
    if (bytes.byteLength === 0) {
      throw new Error("File is empty");
    }
    if (bytes.byteLength > UPLOAD_SIZE_LIMIT_BYTES) {
      throw new Error("File exceeds the upload size limit");
    }

    const adapter = await getConfiguredAdapter();
    const destination = `${EDUCATION_RESOURCE_PATH_PREFIX}/${uuidV7()}_${sanitizeFilename(data.fileName)}`;
    const result = await putVerified(
      adapter,
      bytes,
      destination,
      data.mimetype,
    );

    const row = await db
      .insertInto("resources")
      .values({
        id: uuidV7(),
        store: adapter.name,
        store_version: adapter.version,
        uri: result.uri,
        // Server-computed, matching the event-form path: a provider ETag is
        // not comparable across backends.
        hash: sha256Hex(bytes),
        mimetype: data.mimetype,
        description: data.fileName.slice(0, 255),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { id: row.id };
  });

// ── Route ─────────────────────────────────────────────────────────────

export const Route = createFileRoute("/app/education/$id/editor")({
  component: RouteComponent,
  loader: async ({ params }) => {
    if (params.id === "new") return { content: null };
    const content = await getContentById({ data: { id: params.id } });
    return { content };
  },
});

// ── Component ─────────────────────────────────────────────────────────

type ContentFormState = {
  title: string;
  description: string;
  content_type: "tiptap" | "resource";
  tiptap_content: Record<string, unknown> | null;
  resource_id: string | null;
  resource_name: string | null;
  status: "draft" | "published";
  visibility: "public" | "private";
  language: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
  { value: "es", label: "Spanish" },
] as const;

/** Tags from the DB may arrive as a JSON string or already-parsed array. */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not valid JSON
    }
  }
  return [];
}

function RouteComponent() {
  const { content } = Route.useLoaderData();
  const { id: paramId } = Route.useParams();
  const router = useRouter();
  const isNew = paramId === "new";

  const [form, setForm] = useState<ContentFormState>(() => ({
    title: content?.title ?? "",
    description: content?.description ?? "",
    content_type: (content?.content_type as "tiptap" | "resource") ?? "tiptap",
    tiptap_content:
      (content?.tiptap_content as Record<string, unknown>) ?? null,
    resource_id: content?.resource_id ?? null,
    resource_name: null,
    status: (content?.status as "draft" | "published") ?? "draft",
    visibility: (content?.visibility as "public" | "private") ?? "private",
    language: content?.language ?? "en",
    tags: parseTags(content?.tags),
    metadata: (content?.metadata as Record<string, unknown>) ?? {},
  }));

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const updateField = <K extends keyof ContentFormState>(
    key: K,
    value: ContentFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!form.title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (form.content_type === "resource" && !form.resource_id) {
      toast.error("Please upload a file for resource-type content");
      return;
    }

    setSaving(true);
    try {
      const result = await saveContent({
        data: {
          id: isNew ? null : paramId,
          title: form.title,
          description: form.description || null,
          content_type: form.content_type,
          tiptap_content:
            form.content_type === "tiptap" ? form.tiptap_content : null,
          resource_id:
            form.content_type === "resource" ? form.resource_id : null,
          status: form.status,
          visibility: form.visibility,
          language: form.language,
          tags: form.tags,
          metadata: form.metadata,
        },
      });
      toast.success(isNew ? "Content created" : "Content saved");
      if (isNew && result?.id) {
        router.navigate({
          to: "/app/education/$id/editor",
          params: { id: result.id },
        });
      }
    } catch {
      toast.error("Failed to save content");
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setUploading(true);
      try {
        const buffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(buffer).reduce(
            (s, b) => s + String.fromCharCode(b),
            "",
          ),
        );
        const resource = await uploadFile({
          data: {
            fileName: file.name,
            mimetype: file.type,
            fileBase64: base64,
          },
        });
        updateField("resource_id", resource.id);
        updateField("resource_name", file.name);
        toast.success("File uploaded");
      } catch {
        toast.error("Failed to upload file");
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  /** Upload an image from inside TipTap and return its URL. */
  const handleEditorImageUpload = useCallback(
    async (file: File): Promise<string> => {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), ""),
      );
      const resource = await uploadFile({
        data: {
          fileName: file.name,
          mimetype: file.type,
          fileBase64: base64,
        },
      });
      return `/api/resources/${resource.id}`;
    },
    [],
  );

  return (
    <div className="max-w-5xl mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {isNew ? "New Education Content" : "Edit Education Content"}
        </h1>
        <div className="flex items-center gap-2">
          {!isNew &&
            content?.status === "published" &&
            content?.visibility === "public" && (
              <a
                href={`/education/${paramId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm">
                  <LucideEye className="mr-1 h-4 w-4" /> Preview
                </Button>
              </a>
            )}
          <Button onClick={handleSave} disabled={saving}>
            <LucideSave className="mr-1 h-4 w-4" />
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <Separator />

      {/* Title & Description */}
      <div className="space-y-4">
        <div>
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={form.title}
            onChange={(e) => updateField("title", e.target.value)}
            placeholder="Enter content title..."
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="description">Description (optional)</Label>
          <Textarea
            id="description"
            value={form.description}
            onChange={(e) => updateField("description", e.target.value)}
            placeholder="Brief summary of the content..."
            className="mt-1"
            rows={2}
          />
        </div>
      </div>

      <Separator />

      {/* Content Type Selector */}
      <div className="space-y-4">
        <div>
          <Label>Content Type</Label>
          <div className="flex gap-4 mt-2">
            <Button
              variant={form.content_type === "tiptap" ? "default" : "outline"}
              onClick={() => updateField("content_type", "tiptap")}
              size="sm"
            >
              Rich Text Editor
            </Button>
            <Button
              variant={form.content_type === "resource" ? "default" : "outline"}
              onClick={() => updateField("content_type", "resource")}
              size="sm"
            >
              Upload File (PDF/Image)
            </Button>
          </div>
        </div>

        {/* TipTap Editor */}
        {form.content_type === "tiptap" && (
          <div>
            <Label>Content</Label>
            <div className="mt-2 border rounded-md">
              <TipTapEditor
                content={form.tiptap_content}
                onUpdate={(json) => updateField("tiptap_content", json)}
                onImageUpload={handleEditorImageUpload}
              />
            </div>
          </div>
        )}

        {/* File Upload */}
        {form.content_type === "resource" && (
          <div className="space-y-3">
            <Label>Upload File</Label>
            <div className="flex items-center gap-4">
              <label className="cursor-pointer">
                <div className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-gray-50 transition-colors">
                  <LucideUpload className="h-4 w-4" />
                  <span>{uploading ? "Uploading..." : "Choose File"}</span>
                </div>
                <input
                  type="file"
                  className="hidden"
                  accept="application/pdf,image/*"
                  onChange={handleFileUpload}
                  disabled={uploading}
                />
              </label>
              {(form.resource_name || form.resource_id) && (
                <Badge variant="secondary">
                  {form.resource_name ??
                    `Resource: ${form.resource_id?.slice(0, 8)}...`}
                </Badge>
              )}
            </div>
          </div>
        )}
      </div>

      <Separator />

      {/* Settings */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Status */}
        <div>
          <Label>Status</Label>
          <div className="flex gap-2 mt-2">
            <Button
              variant={form.status === "draft" ? "default" : "outline"}
              onClick={() => updateField("status", "draft")}
              size="sm"
            >
              Draft
            </Button>
            <Button
              variant={form.status === "published" ? "default" : "outline"}
              onClick={() => updateField("status", "published")}
              size="sm"
            >
              Published
            </Button>
          </div>
        </div>

        {/* Visibility */}
        <div>
          <Label>Visibility</Label>
          <div className="flex gap-2 mt-2">
            <Button
              variant={form.visibility === "private" ? "default" : "outline"}
              onClick={() => updateField("visibility", "private")}
              size="sm"
            >
              <LucideLock className="mr-1 h-3.5 w-3.5" /> Private
            </Button>
            <Button
              variant={form.visibility === "public" ? "default" : "outline"}
              onClick={() => updateField("visibility", "public")}
              size="sm"
            >
              <LucideGlobe className="mr-1 h-3.5 w-3.5" /> Public
            </Button>
          </div>
        </div>

        {/* Language */}
        <div>
          <Label htmlFor="language">Language</Label>
          <select
            id="language"
            value={form.language}
            onChange={(e) => updateField("language", e.target.value)}
            className="mt-1 flex h-9 w-full max-w-48 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Tags */}
        <div>
          <Label>Tags</Label>
          <div className="mt-1">
            <CreatableSelect
              isMulti
              value={form.tags.map((t) => ({ label: t, value: t }))}
              onChange={(selected) =>
                updateField(
                  "tags",
                  selected.map((s) => s.value),
                )
              }
              placeholder="Add tags..."
              classNames={{
                control: () => "!min-h-9 !border-input !shadow-sm",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
