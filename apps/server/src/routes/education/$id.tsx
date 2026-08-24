import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LucideArrowLeft } from "lucide-react";
import { format } from "date-fns";
import db from "@/db";
import type EducationContent from "@/models/education-content";
import { generateHTML } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Youtube from "@tiptap/extension-youtube";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import DOMPurify from "isomorphic-dompurify";

type ContentResult = {
  content: EducationContent.Serialized;
  resource: { id: string; mimetype: string } | null;
};

const getPublicContentById = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<ContentResult | null> => {
    const content = await db
      .selectFrom("education_content")
      .selectAll()
      .where("id", "=", data.id)
      .where("is_deleted", "=", false)
      .where("status", "=", "published")
      .where("visibility", "=", "public")
      .executeTakeFirst();

    if (!content) return null;

    let resource = null;
    if (content.content_type === "resource" && content.resource_id) {
      resource = await db
        .selectFrom("resources")
        .selectAll()
        .where("id", "=", content.resource_id)
        .executeTakeFirst();
    }

    return {
      content: content as unknown as EducationContent.Serialized,
      resource: resource ? { id: resource.id, mimetype: resource.mimetype } : null,
    };
  });

export const Route = createFileRoute("/education/$id")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const result = await getPublicContentById({ data: { id: params.id } });
    return { result };
  },
});

function RouteComponent() {
  const { result } = Route.useLoaderData();

  if (!result) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold mb-4">Content Not Found</h1>
        <p className="text-gray-500 mb-6">
          This content may have been removed or is not publicly available.
        </p>
        <Link to="/education">
          <Button variant="outline">
            <LucideArrowLeft className="mr-1 h-4 w-4" /> Back to Education
          </Button>
        </Link>
      </div>
    );
  }

  const { content, resource } = result;
  const tags = (content.tags as string[]) ?? [];

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link to="/education" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 mb-6">
        <LucideArrowLeft className="mr-1 h-4 w-4" /> All Education Content
      </Link>

      <article>
        <h1 className="text-3xl font-bold mb-2">{content.title}</h1>
        {content.description && (
          <p className="text-lg text-gray-600 mb-4">{content.description}</p>
        )}
        <div className="flex items-center gap-3 text-sm text-gray-400 mb-6">
          {content.published_at && (
            <span>{format(new Date(content.published_at), "MMMM d, yyyy")}</span>
          )}
          {tags.length > 0 && (
            <div className="flex gap-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* TipTap content rendered as HTML */}
        {content.content_type === "tiptap" && content.tiptap_content && (
          <TipTapRenderer content={content.tiptap_content as Record<string, unknown>} />
        )}

        {/* Resource content (PDF/image) */}
        {content.content_type === "resource" && resource && (
          <ResourceViewer mimetype={resource.mimetype} resourceId={resource.id} />
        )}
      </article>
    </div>
  );
}

function TipTapRenderer({ content }: { content: Record<string, unknown> }) {
  const rawHtml = generateHTML(content as Parameters<typeof generateHTML>[0], [
    StarterKit,
    Image,
    Youtube,
    Table,
    TableRow,
    TableCell,
    TableHeader,
  ]);

  // Sanitize to prevent XSS from manipulated TipTap JSON stored in the database
  const html = DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ["iframe"],
    ADD_ATTR: ["allowfullscreen", "frameborder", "src"],
  });

  return (
    <div
      className="prose prose-sm max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ResourceViewer({ mimetype, resourceId }: { mimetype: string; resourceId: string }) {
  const url = `/api/resources/${resourceId}`;

  if (mimetype === "application/pdf") {
    return (
      <iframe
        src={url}
        className="w-full h-[80vh] border rounded-md"
        title="PDF Document"
      />
    );
  }

  if (mimetype.startsWith("image/")) {
    return (
      <img
        src={url}
        alt="Education content"
        className="max-w-full rounded-md"
      />
    );
  }

  return (
    <div className="text-center py-8">
      <a href={url} download className="text-blue-600 hover:underline">
        Download file
      </a>
    </div>
  );
}
