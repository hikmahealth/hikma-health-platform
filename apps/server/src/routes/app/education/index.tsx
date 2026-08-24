import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  LucideTrash,
  LucidePencil,
  LucidePlus,
  LucideGlobe,
  LucideLock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { format } from "date-fns";
import db from "@/db";
import { sql } from "kysely";
import type EducationContent from "@/models/education-content";
import { adminMiddleware } from "@/middleware/auth";

type ContentRow = EducationContent.Serialized;

const getEducationContent = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async (): Promise<ContentRow[]> => {
    const rows = await db
      .selectFrom("education_content")
      .selectAll()
      .where("is_deleted", "=", false)
      .orderBy("updated_at", "desc")
      .execute();
    return rows as unknown as ContentRow[];
  });

const deleteEducationContent = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    await db
      .updateTable("education_content")
      .set({ is_deleted: true, deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", data.id)
      .where("is_deleted", "=", false)
      .execute();
    return { success: true };
  });

export const Route = createFileRoute("/app/education/")({
  component: RouteComponent,
  loader: async () => {
    const content = await getEducationContent();
    return { content };
  },
});

function RouteComponent() {
  const { content: initialContent } = Route.useLoaderData();
  const [contentList, setContentList] = useState<ContentRow[]>(initialContent);

  const handleDelete = async (id: string, title: string) => {
    const confirmed = confirm(
      `Delete "${title}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      await deleteEducationContent({ data: { id } });
      setContentList(contentList.filter((c) => c.id !== id));
      toast.success("Content deleted");
    } catch {
      toast.error("Failed to delete content");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-semibold">Education Content</h1>
        <Link to="/app/education/$id/editor" params={{ id: "new" }}>
          <Button>
            <LucidePlus className="mr-2 h-4 w-4" />
            New Content
          </Button>
        </Link>
      </div>

      {contentList.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] text-center space-y-4">
          <p className="text-gray-500">No education content yet.</p>
          <Link to="/app/education/$id/editor" params={{ id: "new" }}>
            <Button>Create your first content</Button>
          </Link>
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">Title</TableHead>
                <TableHead className="px-4">Type</TableHead>
                <TableHead className="px-4">Status</TableHead>
                <TableHead className="px-4">Visibility</TableHead>
                <TableHead className="px-4">Language</TableHead>
                <TableHead className="px-4">Updated</TableHead>
                <TableHead className="px-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contentList.map((item) => (
                <TableRow key={item.id} className="hover:bg-gray-50">
                  <TableCell className="px-4 font-medium">
                    <Link
                      to="/app/education/$id/editor"
                      params={{ id: item.id }}
                      className="hover:underline"
                    >
                      {item.title}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4">
                    <Badge variant="outline">
                      {item.content_type === "tiptap" ? "Rich Text" : "File"}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4">
                    <Badge
                      variant={
                        item.status === "published" ? "default" : "secondary"
                      }
                    >
                      {item.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4">
                    {item.visibility === "public" ? (
                      <span className="flex items-center gap-1 text-green-700">
                        <LucideGlobe className="h-3.5 w-3.5" /> Public
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-gray-500">
                        <LucideLock className="h-3.5 w-3.5" /> Private
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="px-4">{item.language}</TableCell>
                  <TableCell className="px-4 text-sm text-gray-500">
                    {format(new Date(item.updated_at), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell className="px-4">
                    <div className="flex items-center gap-2">
                      <Link
                        to="/app/education/$id/editor"
                        params={{ id: item.id }}
                      >
                        <Button variant="outline" size="sm">
                          <LucidePencil className="h-3.5 w-3.5" />
                        </Button>
                      </Link>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(item.id, item.title)}
                        className="text-red-600 hover:text-red-700"
                      >
                        <LucideTrash className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
