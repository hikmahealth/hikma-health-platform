import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as React from "react";
import { useState, useEffect } from "react";
import type ClinicInventory from "@/models/clinic-inventory";
import Clinic from "@/models/clinic";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { getAllClinics } from "@/lib/server-functions/clinics";
import { getClinicInventory } from "@/lib/server-functions/inventory";
import { Result } from "@/lib/result";
import { LucidePlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Logger } from "@hikmahealth/js-utils";

const ITEMS_PER_PAGE = 100;

type InventoryPage = {
  items: ClinicInventory.DrugWithBatchInfo[];
  hasMore: boolean;
  total: number;
};

const EMPTY_INVENTORY: InventoryPage = {
  items: [],
  hasMore: false,
  total: 0,
};

export const Route = createFileRoute("/app/inventory/clinic-inventory/")({
  component: RouteComponent,
  loader: async () => {
    const clinics = Result.getOrElse(await getAllClinics(), []);
    return {
      clinics,
      initialInventory: EMPTY_INVENTORY,
    };
  },
});

function RouteComponent() {
  const { clinics, initialInventory } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedClinicId, setSelectedClinicId] = useState<string>("");
  const [inventory, setInventory] = useState(initialInventory);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);

  // Update total pages based on whether there are more items
  useEffect(() => {
    if (inventory?.hasMore) {
      // If we have more items, set total pages to at least current + 1
      setTotalPages(Math.max(totalPages, currentPage + 1));
    } else {
      // If no more items, current page is the last
      setTotalPages(currentPage);
    }
  }, [inventory?.hasMore, currentPage]);

  // Load inventory when clinic is selected
  const handleClinicChange = async (clinicId: string) => {
    setSelectedClinicId(clinicId);
    setCurrentPage(1);
    await loadInventory(clinicId, 1);
  };

  const loadInventory = async (clinicId: string, page: number) => {
    if (!clinicId) return;

    setLoading(true);
    try {
      const offset = (page - 1) * ITEMS_PER_PAGE;
      const result = await getClinicInventory({
        data: {
          clinicId,
          searchQuery,
          limit: ITEMS_PER_PAGE,
          offset,
        },
      });
      setInventory(Result.getOrElse(result, EMPTY_INVENTORY));
      setCurrentPage(page);
    } catch (error) {
      Logger.error({ msg: "Error loading inventory:", error });
      toast.error("Failed to load inventory");
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = (page: number) => {
    if (page < 1 || page > totalPages || !selectedClinicId) return;
    loadInventory(selectedClinicId, page);
  };

  const handleStockCount = async () => {
    // TODO: Implement stock count functionality
    toast.info("Stock count functionality coming soon");
  };

  const handleEdit = (drugId: string) => {
    navigate({
      to: "/app/inventory/clinic-inventory/drug/edit/$",
      params: { _splat: drugId },
      search: { clinicId: selectedClinicId || undefined },
    });
  };

  const handleAddNewItem = () => {
    navigate({
      to: "/app/inventory/clinic-inventory/drug/edit/$",
      params: {
        _splat: "new",
      },
      search: { clinicId: selectedClinicId || undefined },
    });
  };

  // Generate page numbers to display
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

  const formatDate = (date: string | Date | null) => {
    if (!date) return "-";
    return new Date(date).toLocaleDateString();
  };

  const pageNumbers = getPageNumbers();
  const selectedClinic = clinics?.find((c: any) => c.id === selectedClinicId);

  Logger.log({ inventory });

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Clinic Inventory</h1>
          {selectedClinic && (
            <div className="text-sm text-muted-foreground">
              {selectedClinic.name}
            </div>
          )}
        </div>
      </div>

      {/* Clinic Selector Section */}
      <div className="w-full flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4 flex-1">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search for drug by name ..."
          />
          <Select value={selectedClinicId} onValueChange={handleClinicChange}>
            <SelectTrigger className="max-w-md lg:w-md">
              <SelectValue placeholder="Select a clinic to view inventory" />
            </SelectTrigger>
            <SelectContent>
              {clinics?.map((clinic: any) => (
                <SelectItem key={clinic.id} value={clinic.id}>
                  {clinic.name || "Unnamed Clinic"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedClinicId && (
            <Button
              variant="outline"
              onClick={() => loadInventory(selectedClinicId, currentPage)}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          )}
        </div>
        {selectedClinicId && (
          <Button onClick={handleAddNewItem}>
            <LucidePlus />
            Add New Item
          </Button>
        )}
      </div>

      {/* Medication count */}
      {selectedClinicId && (
        <p className="text-sm text-muted-foreground mb-2">
          {loading
            ? "Counting medicines..."
            : `${inventory.total} ${
                inventory.total === 1 ? "medicine" : "medicines"
              } in this clinic${searchQuery.trim() ? " matching your search" : ""}`}
        </p>
      )}

      {/* Table */}
      {selectedClinicId ? (
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Actions</TableHead>
                <TableHead>Drug Name</TableHead>
                <TableHead>Form</TableHead>
                <TableHead className="text-center">Quantity</TableHead>
                <TableHead className="text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventory?.items?.map((item: any) => {
                const isLowStock = false;
                // min_stock_level not available in current API response
                // TODO: Add min_stock_level to getWithDrugInfo query

                return (
                  <TableRow key={item.drug_id}>
                    <TableCell className="space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEdit(item.drug_id)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleStockCount()}
                      >
                        Count
                      </Button>
                    </TableCell>
                    <TableCell className="font-medium">
                      {item.brand_name || "-"}
                      {item.is_controlled && (
                        <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
                          Controlled
                        </span>
                      )}
                      {item.requires_refrigeration && (
                        <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                          Refrigerate
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.brand_name || "-"}

                      <p className="text-xs text-gray-500">
                        {item.generic_name || "-"}
                      </p>
                    </TableCell>
                    <TableCell>
                      {/*Render as table ... otherwise it shows up wierd*/}
                      <table className="min-w-full">
                        <tbody>
                          <tr>
                            <td className="text-left pr-2">Available:</td>
                            <td
                              className={`text-right ${isLowStock ? "text-red-600 font-semibold" : ""}`}
                            >
                              {item.quantity}
                            </td>
                          </tr>
                          <tr>
                            <td className="text-left pr-2">Reserved:</td>
                            <td className="text-right">
                              {item.reserved_quantity}
                            </td>
                          </tr>
                          <tr>
                            <td className="text-left pr-2 font-semibold">
                              Total:
                            </td>
                            <td className="text-right font-semibold">
                              {(
                                parseInt(item.quantity) +
                                parseInt(item.reserved_quantity)
                              ).toLocaleString()}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </TableCell>
                    <TableCell className="text-center">
                      {isLowStock ? (
                        <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                          Low Stock
                        </span>
                      ) : item.quantity === 0 ? (
                        <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
                          Out of Stock
                        </span>
                      ) : (
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                          In Stock
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {inventory?.items?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-4">
                    No inventory items found for this clinic
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-md border p-8">
          <div className="text-center text-muted-foreground">
            Please select a clinic to view its inventory
          </div>
        </div>
      )}

      {/* Pagination */}
      {selectedClinicId && totalPages > 1 && (
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
