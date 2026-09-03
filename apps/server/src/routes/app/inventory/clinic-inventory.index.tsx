import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as React from "react";
import { useState } from "react";
import type ClinicInventory from "@/models/clinic-inventory";
import { pageCount } from "@/lib/server-functions/builders";
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
import {
  clearClinicInventory,
  getClinicInventory,
  removeDrugFromClinic,
} from "@/lib/server-functions/inventory";
import { Result } from "@/lib/result";
import { LucidePlus, Trash } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Logger } from "@hikmahealth/js-utils";
import { formatDrugStrength } from "@/lib/utils";
import { upperFirst } from "es-toolkit/compat";

const ITEMS_PER_PAGE = 100;

const medicines = (count: number) =>
  `${count} ${count === 1 ? "medicine" : "medicines"}`;

// Keyed by the model's union so a renamed sort breaks the build. Type-only
// import — a real one would pull the db into the client bundle.
const SORT_LABELS: Record<ClinicInventory.SortOption, string> = {
  brand_name: "Brand name (A–Z)",
  generic_name: "Generic name (A–Z)",
  quantity_desc: "Quantity (most first)",
  quantity_asc: "Quantity (least first)",
};

const DEFAULT_SORT: ClinicInventory.SortOption = "brand_name";

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
  const [loading, setLoading] = useState(false);
  const [removingDrugId, setRemovingDrugId] = useState<string | null>(null);
  const [clearingInventory, setClearingInventory] = useState(false);
  const [sortBy, setSortBy] =
    useState<ClinicInventory.SortOption>(DEFAULT_SORT);
  // The clinic the rows on screen were loaded for. `selectedClinicId` flips as
  // soon as the picker changes, a round-trip before the rows catch up, so a
  // destructive action has to bind to this rather than to the picker.
  const [loadedClinicId, setLoadedClinicId] = useState<string>("");

  // The real count, not `hasMore` — which only meant "at least one more".
  // `countStockedDrugs` shares the listing's base query, so it counts the
  // same rows.
  const totalPages = pageCount(inventory.total, ITEMS_PER_PAGE);

  const handleClinicChange = async (clinicId: string) => {
    setSelectedClinicId(clinicId);
    setCurrentPage(1);
    await loadInventory(clinicId, 1);
  };

  // A parameter, not a closure read, so the dropdown can load its new value in
  // the same tick it sets it.
  const loadInventory = async (
    clinicId: string,
    page: number,
    sort: ClinicInventory.SortOption = sortBy,
  ) => {
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
          sort,
        },
      });
      setInventory(Result.getOrElse(result, EMPTY_INVENTORY));
      setLoadedClinicId(clinicId);
      setCurrentPage(page);
    } catch (error) {
      Logger.error({ msg: "Error loading inventory:", error });
      toast.error("Failed to load inventory");
    } finally {
      setLoading(false);
    }
  };

  // Re-sorting reorders the whole result set, so the page means nothing.
  const handleSortChange = async (value: string) => {
    const sort = value as ClinicInventory.SortOption;
    setSortBy(sort);
    setCurrentPage(1);
    if (selectedClinicId) {
      await loadInventory(selectedClinicId, 1, sort);
    }
  };

  // Clamped, not rejected: rows can vanish under the page the user is on, and
  // rejecting the step would strand them there.
  const handlePageChange = (page: number) => {
    if (!selectedClinicId) return;
    const target = Math.min(Math.max(1, page), totalPages);
    if (target === currentPage) return;
    loadInventory(selectedClinicId, target);
  };

  // @ts-expect-error not implemented yet, coming soon!
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

  const handleRemoveDrugInventory = async (
    drug: (typeof inventory.items)[number],
  ) => {
    const clinicId = loadedClinicId;
    const { drug_id: drugId, generic_name } = drug;
    const clinic = clinics.find((clinic) => clinic.id === clinicId);
    if (!clinic || clinicId !== selectedClinicId) {
      toast.error("Wait for the clinic's inventory to finish loading.");
      return;
    }

    // The stock this writes off is gone for good, so the prompt names what
    // goes with it rather than asking in the abstract. `destroyable_quantity`
    // is the server's own figure — subtracting the two aggregates overstates
    // it wherever a batch row has gone negative.
    const free = drug.destroyable_quantity;
    const reservedNote =
      drug.reserved_quantity > 0
        ? ` ${drug.reserved_quantity} reserved units stay put for prescriptions already in flight.`
        : "";
    if (
      !window.confirm(
        `Remove ${generic_name} from ${clinic.name}? This destroys ${free} units and takes the product off that clinic's shelves.${reservedNote}\n\n` +
          `The drug stays in the drug catalogue, its stock at other clinics is untouched, and medications already prescribed or dispensed are not affected.\n\n` +
          `It cannot be undone.`,
      )
    ) {
      return;
    }

    setRemovingDrugId(drugId);
    try {
      const result = await removeDrugFromClinic({
        data: { clinicId, drugId },
      });

      if (!result.success) {
        toast.error(result.error || "Failed to remove drug from clinic");
        return;
      }

      const { units_destroyed, units_retained } = result.data;
      toast.success(
        units_retained > 0
          ? `${generic_name} removed from ${clinic.name}. ${units_destroyed} units destroyed, ${units_retained} reserved units kept for prescriptions in flight.`
          : `${generic_name} removed from ${clinic.name}. ${units_destroyed} units destroyed.`,
      );

      // Without this the row keeps its pre-removal quantities and invites a
      // second delete on stock that is already gone.
      await loadInventory(clinicId, currentPage);
    } catch (error) {
      // adminMiddleware throws outside the server fn's own try, so an expired
      // session lands here rather than in the !success branch.
      Logger.error({ msg: "Error removing drug from clinic:", error });
      toast.error("Failed to remove drug from clinic");
    } finally {
      setRemovingDrugId(null);
    }
  };

  const handleClearClinicInventory = async () => {
    const clinicId = loadedClinicId;
    const clinic = clinics.find((clinic) => clinic.id === clinicId);
    if (!clinic || clinicId !== selectedClinicId) {
      toast.error("Wait for the clinic's inventory to finish loading.");
      return;
    }

    // The search box never narrows this. `inventory.total` is search-scoped, so
    // it can only be quoted as the damage when nothing is filtering it.
    const isFiltered = searchQuery.trim().length > 0;
    const scope = isFiltered
      ? "every medicine"
      : `all ${medicines(inventory.total)}`;
    const filterWarning = isFiltered
      ? "\n\nYour search filter does NOT narrow this. Every medicine in the clinic goes, not just the ones listed."
      : "";

    if (
      !window.confirm(
        `Clear the shelves at ${clinic.name}? This removes ${scope} from that clinic and destroys the free stock of each.${filterWarning}\n\n` +
          `Units reserved for prescriptions already in flight stay put, so those medicines remain on the shelves.\n\n` +
          `Drugs stay in the drug catalogue, stock at other clinics is untouched, and medications already prescribed or dispensed are not affected.\n\n` +
          `It cannot be undone.`,
      )
    ) {
      return;
    }

    setClearingInventory(true);
    try {
      const result = await clearClinicInventory({ data: { clinicId } });

      if (!result.success) {
        toast.error(result.error || "Failed to clear the clinic's inventory");
        return;
      }

      const { drugs_cleared, drugs_retained, units_destroyed, units_retained } =
        result.data;

      // An already-cleared clinic is a no-op, not a partial success — it must
      // not read as "0 medicines removed".
      if (drugs_cleared === 0 && units_destroyed === 0) {
        toast.info(
          drugs_retained > 0
            ? `Nothing left to clear at ${clinic.name}. ${medicines(drugs_retained)} ${drugs_retained === 1 ? "holds" : "hold"} only units reserved for prescriptions in flight.`
            : `There was nothing on the shelves at ${clinic.name}.`,
        );
      } else {
        const cleared = `${clinic.name} cleared. ${medicines(drugs_cleared)} removed and ${units_destroyed} units destroyed.`;
        toast.success(
          drugs_retained > 0
            ? `${cleared} ${medicines(drugs_retained)} ${drugs_retained === 1 ? "stays" : "stay"} on the shelves holding ${units_retained} reserved units for prescriptions in flight.`
            : cleared,
        );
      }

      // Rows that kept a reservation are still live, so reload rather than
      // assume the list is empty.
      await loadInventory(clinicId, 1);
    } catch (error) {
      Logger.error({ msg: "Error clearing clinic inventory:", error });
      toast.error("Failed to clear the clinic's inventory");
    } finally {
      setClearingInventory(false);
    }
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

  // With a search active, `inventory.total` says nothing about what the
  // clinic actually stocks.
  const canClearShelves =
    Boolean(selectedClinicId) &&
    (searchQuery.trim().length > 0 || inventory.total > 0);

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
            <Select value={sortBy} onValueChange={handleSortChange}>
              <SelectTrigger className="w-56" aria-label="Sort inventory by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SORT_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
          <div className="flex items-center gap-2">
            {canClearShelves && (
              <Button
                variant="destructive"
                onClick={handleClearClinicInventory}
                disabled={
                  clearingInventory || loading || removingDrugId !== null
                }
              >
                <Trash />
                {clearingInventory ? "Clearing..." : "Clear Shelves"}
              </Button>
            )}
            <Button onClick={handleAddNewItem}>
              <LucidePlus />
              Add New Item
            </Button>
          </div>
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
                <TableHead>Drug Name</TableHead>
                <TableHead>Form</TableHead>
                <TableHead className="">Quantity</TableHead>
                <TableHead className="">Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventory?.items?.map((item) => {
                const isLowStock = false;
                // min_stock_level not available in current API response
                // TODO: Add min_stock_level to getWithDrugInfo query

                // Reserved units are carved out of `quantity`, not held
                // alongside it. The free count is summed per row by the query,
                // not derived here — see `destroyable_quantity`.
                const freeQuantity = item.destroyable_quantity;
                const strength = formatDrugStrength(item.dosage_quantity);

                return (
                  <TableRow key={item.drug_id}>
                    <TableCell className="font-medium">
                      {item.brand_name || item.generic_name || "-"}
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
                      {upperFirst(item.form || "-")}
                      {strength && (
                        <p className="text-gray-800">
                          {strength} {item.dosage_units}
                        </p>
                      )}
                      <p className="text-xs text-gray-500">
                        {upperFirst(item.generic_name || "-")}
                      </p>
                    </TableCell>
                    <TableCell>
                      {/*Render as table ... otherwise it shows up wierd*/}
                      <table className="min-w-full">
                        <tbody>
                          <tr>
                            <td className="text-left pr-2">Free:</td>
                            <td
                              className={`text-right ${isLowStock ? "text-red-600 font-semibold" : ""}`}
                            >
                              {freeQuantity.toLocaleString()}
                            </td>
                          </tr>
                          <tr>
                            <td className="text-left pr-2">Reserved:</td>
                            <td className="text-right">
                              {item.reserved_quantity.toLocaleString()}
                            </td>
                          </tr>
                          <tr>
                            <td className="text-left pr-2 font-semibold">
                              Total:
                            </td>
                            <td className="text-right font-semibold">
                              {item.quantity.toLocaleString()}
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
                    <TableCell className="space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEdit(item.drug_id)}
                      >
                        Edit
                      </Button>
                      {/*
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleStockCount()}
                      >
                        Count
                      </Button>
                      */}

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={removingDrugId !== null || clearingInventory}
                        onClick={() => handleRemoveDrugInventory(item)}
                      >
                        <Trash color="red" />
                        {removingDrugId === item.drug_id
                          ? "Removing..."
                          : "Remove from Clinic"}
                      </Button>
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

      {/* Also shown when the page has fallen off the end, to offer a way back. */}
      {selectedClinicId && (totalPages > 1 || currentPage > totalPages) && (
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
