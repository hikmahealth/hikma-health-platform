import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { useState, useEffect } from "react";
import DrugCatalogue from "@/models/drug-catalogue";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { toast } from "sonner";
import { LucideEdit, LucideTrash } from "lucide-react";
import {
  deleteDrug,
  getAllDrugs,
  getDrugStats,
  searchDrugs,
} from "@/lib/server-functions/drugs";
import { currentUserHasRole } from "@/lib/server-functions/users";
import { Logger } from "@hikmahealth/js-utils";

const ITEMS_PER_PAGE = 100;

export const Route = createFileRoute("/app/inventory/drug-catalogue/")({
  component: RouteComponent,
  loader: async () => {
    const [drugs, stats, isSuperAdmin] = await Promise.all([
      getAllDrugs({ data: { limit: ITEMS_PER_PAGE, offset: 0 } }),
      getDrugStats(),
      // Reading the catalogue only needs admin, but every write behind these
      // controls is super-admin only.
      currentUserHasRole({ data: { role: "super_admin" } }),
    ]);

    return {
      initialDrugs: drugs,
      stats,
      isSuperAdmin,
    };
  },
});

function RouteComponent() {
  const { initialDrugs, stats, isSuperAdmin } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [drugs, setDrugs] = useState<DrugCatalogue.ApiDrug[]>(initialDrugs);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(
    Math.ceil((stats?.totalDrugs ?? 0) / ITEMS_PER_PAGE),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (searchQuery) {
      // When searching, we don't know the exact total, so we check if we got a full page
      setTotalPages(
        drugs.length === ITEMS_PER_PAGE ? currentPage + 1 : currentPage,
      );
    } else {
      setTotalPages(Math.ceil((stats?.totalDrugs ?? 0) / ITEMS_PER_PAGE));
    }
  }, [drugs, searchQuery, currentPage, stats?.totalDrugs]);

  const handleSearch = async (page: number = 1) => {
    setLoading(true);
    try {
      const offset = (page - 1) * ITEMS_PER_PAGE;

      let result;
      if (searchQuery.trim()) {
        result = await searchDrugs({
          data: {
            searchTerm: searchQuery,
            limit: ITEMS_PER_PAGE,
            offset,
          },
        });
      } else {
        result = await getAllDrugs({
          data: {
            limit: ITEMS_PER_PAGE,
            offset,
          },
        });
      }

      setDrugs(result);
      setCurrentPage(page);
    } catch (error) {
      Logger.error({ msg: "Error loading drugs:", error });
      toast.error("Failed to load drugs");
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = (page: number) => {
    if (page < 1 || page > totalPages) return;
    handleSearch(page);
  };

  const handleEdit = (id: string) => {
    navigate({ to: `/app/inventory/drug-catalogue/edit/${id}` });
  };

  const handleDelete = async (drug: DrugCatalogue.ApiDrug) => {
    const name = drug.brand_name
      ? `${drug.generic_name} (${drug.brand_name})`
      : drug.generic_name;
    const confirmed = window.confirm(
      `Delete ${name} from the catalogue? It will stop syncing to devices, ` +
        `though existing prescriptions and stock records keep referring to it. ` +
        `To stop it being prescribed without removing it, edit the drug and ` +
        `uncheck "Active" instead.`,
    );
    if (!confirmed) return;

    try {
      await deleteDrug({ data: { id: drug.id } });
      toast.success("Drug deleted successfully");
      // The rows live in local state and the total lives in loader data, so
      // neither refreshes the other.
      await handleSearch(currentPage);
      router.invalidate();
    } catch (error) {
      Logger.error({ msg: "Error deleting drug:", error });
      toast.error("Failed to delete drug");
    }
  };

  const getPageNumbers = () => {
    const firstPage = 1;
    const lastPage = totalPages;

    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const nearbyPages = Array.from(
      { length: 3 },
      (_, i) => Math.max(2, currentPage - 1) + i,
    ).filter((page) => page > firstPage && page < lastPage);

    return Array.from(new Set([firstPage, ...nearbyPages, lastPage])).sort(
      (a, b) => a - b,
    );
  };

  const formatDosage = (drug: any) => {
    return `${parseFloat(drug.dosage_quantity)} ${drug.dosage_units}`;
  };

  const formatPrice = (drug: any) => {
    if (!drug.sale_price) return "-";
    return drug.sale_currency
      ? `${drug.sale_currency} ${drug.sale_price}`
      : drug.sale_price.toString();
  };

  const pageNumbers = getPageNumbers();

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Drug Catalogue</h1>
          <div className="text-sm text-muted-foreground">
            Total: {stats?.totalDrugs ?? 0} drugs
          </div>
        </div>
        {isSuperAdmin && (
          <Link
            to="/app/inventory/drug-catalogue/edit/$"
            params={{
              _splat: "new",
            }}
          >
            <Button>Add Drug</Button>
          </Link>
        )}
      </div>

      {/* Search Section */}
      <div className="w-full flex items-center gap-4 mb-6">
        <Input
          className="max-w-md"
          placeholder="Search by brand name or generic name..."
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSearch(1);
            }
          }}
        />
        <Button
          type="submit"
          onClick={() => handleSearch(1)}
          disabled={loading}
        >
          {loading ? "Searching..." : "Search"}
        </Button>
        {searchQuery && (
          <Button
            variant="outline"
            onClick={() => {
              setSearchQuery("");
              handleSearch(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {isSuperAdmin && <TableHead>Actions</TableHead>}
              <TableHead>Generic Name</TableHead>
              <TableHead>Brand Name</TableHead>
              <TableHead>Form</TableHead>
              <TableHead>Dosage</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Manufacturer</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Min Stock</TableHead>
              <TableHead>Barcode</TableHead>
              <TableHead className="text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drugs.map((drug) => (
              <TableRow key={drug.id}>
                {isSuperAdmin && (
                  <TableCell className="space-x-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEdit(drug.id)}
                    >
                      <LucideEdit />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      color="red"
                      onClick={() => handleDelete(drug)}
                    >
                      <LucideTrash color="red" />
                    </Button>
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  {drug.generic_name}
                  {drug.is_controlled && (
                    <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
                      Controlled
                    </span>
                  )}
                  {drug.requires_refrigeration && (
                    <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      Refrigerate
                    </span>
                  )}
                </TableCell>
                <TableCell>{drug.brand_name || "-"}</TableCell>
                <TableCell>{drug.form}</TableCell>
                <TableCell>{formatDosage(drug)}</TableCell>
                <TableCell>{drug.route}</TableCell>
                <TableCell>{drug.manufacturer || "-"}</TableCell>
                <TableCell>{formatPrice(drug)}</TableCell>
                <TableCell>{drug.min_stock_level || "-"}</TableCell>
                <TableCell className="font-mono text-sm">
                  {drug.barcode || "-"}
                </TableCell>
                <TableCell className="text-center">
                  {drug.is_active ? (
                    <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                      Active
                    </span>
                  ) : (
                    <span className="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">
                      Inactive
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {drugs.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={isSuperAdmin ? 11 : 10}
                  className="text-center py-4"
                >
                  {searchQuery
                    ? "No drugs found matching your search"
                    : "No drugs found"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="py-8">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => handlePageChange(currentPage - 1)}
                  className={
                    currentPage <= 1
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>

              {pageNumbers.map((pageNumber, index) => {
                const shouldShowEllipsis =
                  index > 0 && pageNumber > pageNumbers[index - 1] + 1;

                return (
                  <React.Fragment key={`page-${pageNumber}`}>
                    {shouldShowEllipsis && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    <PaginationItem>
                      <PaginationLink
                        onClick={() => handlePageChange(pageNumber)}
                        isActive={pageNumber === currentPage}
                        className="cursor-pointer"
                      >
                        {pageNumber}
                      </PaginationLink>
                    </PaginationItem>
                  </React.Fragment>
                );
              })}

              <PaginationItem>
                <PaginationNext
                  onClick={() => handlePageChange(currentPage + 1)}
                  className={
                    currentPage >= totalPages
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}
