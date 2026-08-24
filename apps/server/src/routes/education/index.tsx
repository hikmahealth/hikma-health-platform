import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LucideSearch, LucideFileText, LucideFile } from "lucide-react";
import { format } from "date-fns";
import db from "@/db";
import { sql } from "kysely";
import type EducationContent from "@/models/education-content";

type ContentRow = EducationContent.Serialized;

const getPublicContent = createServerFn({ method: "GET" })
  .validator((data: { search?: string }) => data)
  .handler(async ({ data }): Promise<ContentRow[]> => {
    let query = db
      .selectFrom("education_content")
      .selectAll()
      .where("is_deleted", "=", false)
      .where("status", "=", "published")
      .where("visibility", "=", "public");

    const search = data.search?.trim();
    if (search && search.length > 0) {
      const term = `%${search.toLowerCase()}%`;
      query = query.where(({ or, eb }) =>
        or([
          eb(sql`LOWER(title)`, "like", term),
          eb(sql`LOWER(description)`, "like", term),
        ]),
      );
    }

    const rows = await query.orderBy("published_at", "desc").execute();
    return rows as unknown as ContentRow[];
  });

export const Route = createFileRoute("/education/")({
  component: RouteComponent,
  loader: async () => {
    const content = await getPublicContent({ data: {} });
    return { content };
  },
});

function RouteComponent() {
  const { content: initialContent } = Route.useLoaderData();
  const [contentList, setContentList] = useState<ContentRow[]>(initialContent);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const handleSearch = async () => {
    setSearching(true);
    try {
      const results = await getPublicContent({ data: { search: searchQuery } });
      setContentList(results);
    } finally {
      setSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-2">Health Education</h1>
      <p className="text-gray-600 mb-6">
        Browse educational resources about health topics.
      </p>

      {/* Search bar */}
      <div className="flex gap-2 mb-8 max-w-lg">
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search content..."
          type="search"
        />
        <Button onClick={handleSearch} disabled={searching}>
          <LucideSearch className="mr-1 h-4 w-4" />
          {searching ? "..." : "Search"}
        </Button>
      </div>

      {/* Content grid */}
      {contentList.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          {searchQuery ? "No results found." : "No content available yet."}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {contentList.map((item) => (
            <Link
              key={item.id}
              to="/education/$id"
              params={{ id: item.id }}
              className="block border rounded-lg p-5 hover:shadow-md transition-shadow bg-white"
            >
              <div className="flex items-start gap-3">
                <div className="mt-1 text-gray-400">
                  {item.content_type === "tiptap" ? (
                    <LucideFileText className="h-5 w-5" />
                  ) : (
                    <LucideFile className="h-5 w-5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-lg leading-tight mb-1">
                    {item.title}
                  </h2>
                  {item.description && (
                    <p className="text-sm text-gray-600 line-clamp-2 mb-2">
                      {item.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    {item.published_at && (
                      <span>
                        {format(new Date(item.published_at), "MMM d, yyyy")}
                      </span>
                    )}
                    {((item.tags as string[]) ?? []).length > 0 && (
                      <div className="flex gap-1">
                        {(item.tags as string[]).slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
