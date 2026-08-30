import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";

import DrugCatalogue from "@/models/drug-catalogue";
import DrugBatches from "@/models/drug-batches";
import type ClinicInventory from "@/models/clinic-inventory";
import { getCurrentUser } from "@/lib/server-functions/auth";
import { getDrugById } from "@/lib/server-functions/drugs";
import {
  getBatchesByDrug,
  createDrugBatch,
  getClinicDrugStock,
  removeDrugFromClinic,
} from "@/lib/server-functions/inventory";
import { getAllClinics } from "@/lib/server-functions/clinics";
import User from "@/models/user";
import Clinic from "@/models/clinic";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SelectInput } from "@/components/select-input";
import { DrugSearchSelect } from "@/components/drug-search-select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CalendarIcon, Package, Trash2 } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Result } from "@/lib/result";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { currencyCodesOptions } from "@/data/currencies";
import Creatable from "react-select/creatable";
import { Logger } from "@hikmahealth/js-utils";

type NewBatchFormValues = {
  batch_number: string;
  clinic_id: string;
  expiry_date: Date | null;
  manufacture_date: Date | null;
  quantity_received: number;
  supplier_name: string;
  purchase_price: number;
  purchase_currency: string;
  notes: string;
};

const DEFAULT_BATCH_VALUES: NewBatchFormValues = {
  batch_number: "",
  clinic_id: "",
  expiry_date: null,
  manufacture_date: null,
  quantity_received: 0,
  supplier_name: "",
  purchase_price: 0,
  purchase_currency: "USD",
  notes: "",
};

const describeClinicStock = (
  stock: ClinicInventory.ClinicDrugStock,
  drugName: string,
  clinicName: string,
) => {
  if (stock.batch_count === 0) {
    return `No stock of ${drugName} is recorded at ${clinicName}.`;
  }

  const reserved =
    stock.reserved_quantity > 0
      ? `, ${stock.reserved_quantity} of them reserved`
      : "";

  return `${stock.quantity_available} units across ${stock.batch_count} batches at ${clinicName}${reserved}.`;
};

export const Route = createFileRoute(
  "/app/inventory/clinic-inventory/drug/edit/$",
)({
  component: RouteComponent,
  // Carried from the inventory list so both clinic pickers open on the clinic
  // the user was already looking at.
  validateSearch: (search: Record<string, unknown>) => ({
    clinicId: typeof search.clinicId === "string" ? search.clinicId : undefined,
  }),
  loader: async ({ params }) => {
    const drugId = params["_splat"];

    const result: {
      drug: DrugCatalogue.ApiDrug | null;
      batches: DrugBatches.EncodedT[];
      currentUser: User.EncodedT | null;
      clinics: Clinic.EncodedT[];
    } = {
      drug: null,
      batches: [],
      currentUser: null,
      clinics: [],
    };

    if (drugId && drugId !== "new") {
      const drugData = await getDrugById({
        data: { id: drugId },
      });
      result.drug = drugData || null;

      if (drugData) {
        result.batches = Result.getOrElse(
          await getBatchesByDrug({
            data: { drugId: drugData.id, onlyAvailable: false },
          }),
          [],
        );
      }
    }

    result.currentUser = (await getCurrentUser()) as User.EncodedT | null;
    result.clinics = Result.getOrElse(
      await getAllClinics(),
      [],
    ) as Clinic.EncodedT[];

    return result;
  },
});

function RouteComponent() {
  const {
    drug: initialDrug,
    batches: initialBatches,
    currentUser,
    clinics,
  } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const params = Route.useParams();
  const { clinicId: clinicIdFromUrl } = Route.useSearch();
  const drugId = params._splat;
  const isExistingDrug = !!drugId && drugId !== "new";

  const [selectedDrug, setSelectedDrug] =
    useState<DrugCatalogue.ApiDrug | null>(initialDrug);
  const [existingBatches, setExistingBatches] = useState<
    DrugBatches.EncodedT[]
  >(initialBatches || []);
  const [isLoading, setIsLoading] = useState(false);

  // Unlike the batch form's clinic, this never falls back to clinics[0]:
  // destroying stock only opens on a clinic the user actually chose.
  const [removalClinicId, setRemovalClinicId] = useState(clinicIdFromUrl ?? "");
  const [removalStock, setRemovalStock] =
    useState<ClinicInventory.ClinicDrugStock | null>(null);
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const batchForm = useForm<NewBatchFormValues>({
    defaultValues: {
      ...DEFAULT_BATCH_VALUES,
      clinic_id: clinicIdFromUrl || clinics[0]?.id || "",
    },
  });

  // on change of batch_number, if it exists in the batch options, just set the expiry date, manufactur date, and supplier name
  const batchNumber = batchForm.watch("batch_number");
  useEffect(() => {
    const batch = existingBatches.find((b) => b.batch_number === batchNumber);
    if (!batchNumber || batchNumber === "" || !batch) {
      batchForm.setValue("expiry_date", null);
      batchForm.setValue("manufacture_date", null);
      batchForm.setValue("supplier_name", "");
      return;
    }
    if (batch) {
      batchForm.setValue("expiry_date", batch.expiry_date);
      batchForm.setValue("manufacture_date", batch.manufacture_date);
      batchForm.setValue("supplier_name", batch.supplier_name || "");
    }
  }, [batchNumber, existingBatches]);

  Logger.log({ existingBatches });

  const handleDrugSelect = async (drug: DrugCatalogue.ApiDrug | null) => {
    setSelectedDrug(drug);
    if (drug) {
      // Load existing batches for this drug
      const batchesResult = await getBatchesByDrug({
        data: { drugId: drug.id, onlyAvailable: false },
      });
      setExistingBatches(Result.getOrElse(batchesResult, []));
    } else {
      setExistingBatches([]);
    }
  };

  const batchNumberOptions = existingBatches.map((batch) => ({
    value: batch.batch_number,
    label: batch.batch_number,
  }));

  const removalClinicName =
    clinics.find((clinic) => clinic.id === removalClinicId)?.name ||
    "this clinic";

  const loadRemovalStock = useCallback(
    async (clinicId: string) => {
      if (!selectedDrug || !clinicId) {
        return null;
      }

      try {
        const result = await getClinicDrugStock({
          data: { clinicId, drugId: selectedDrug.id },
        });
        return Result.getOrNull(result);
      } catch (error) {
        Logger.error({ msg: "Error loading clinic stock:", error });
        return null;
      }
    },
    [selectedDrug],
  );

  useEffect(() => {
    let isCurrent = true;

    loadRemovalStock(removalClinicId).then((stock) => {
      if (isCurrent) {
        setRemovalStock(stock);
      }
    });

    return () => {
      isCurrent = false;
    };
  }, [loadRemovalStock, removalClinicId]);

  const handleRemoveFromClinic = async () => {
    if (!selectedDrug || !removalClinicId) {
      return;
    }

    setIsRemoving(true);
    try {
      const result = await removeDrugFromClinic({
        data: { clinicId: removalClinicId, drugId: selectedDrug.id },
      });

      if (!result.success) {
        toast.error(result.error || "Failed to remove drug from clinic");
        return;
      }

      const { units_destroyed, units_retained } = result.data;
      toast.success(
        units_retained > 0
          ? `${selectedDrug.generic_name} removed from ${removalClinicName}. ${units_destroyed} units destroyed, ${units_retained} reserved units kept for prescriptions in flight.`
          : `${selectedDrug.generic_name} removed from ${removalClinicName}. ${units_destroyed} units destroyed.`,
      );

      setIsRemoveDialogOpen(false);

      // The clinic stays selected, so re-read its summary or the card keeps
      // offering to destroy stock that is already gone.
      setRemovalStock(await loadRemovalStock(removalClinicId));

      const batchesResult = await getBatchesByDrug({
        data: { drugId: selectedDrug.id, onlyAvailable: false },
      });
      setExistingBatches(Result.getOrElse(batchesResult, []));
    } catch (error) {
      Logger.error({ msg: "Error removing drug from clinic:", error });
      toast.error("Failed to remove drug from clinic");
    } finally {
      setIsRemoving(false);
    }
  };

  // Create a new batch (if needed) or update an existing batch if it exists.
  // TODO: show a confirmation dialog if the batch already exists.
  const handleCreateBatch = async (values: NewBatchFormValues) => {
    if (!selectedDrug || !currentUser) {
      toast.error("Please select a drug first");
      return;
    }

    if (!values.clinic_id) {
      toast.error("Please select a clinic");
      return;
    }

    setIsLoading(true);
    try {
      const result = await createDrugBatch({
        data: {
          drugId: selectedDrug.id,
          clinicId: values.clinic_id,
          batchNumber: values.batch_number,
          expiryDate:
            values.expiry_date?.toISOString() || new Date().toISOString(),
          manufactureDate: values.manufacture_date?.toISOString(),
          quantityReceived: values.quantity_received,
          supplierName: values.supplier_name,
          purchasePrice: values.purchase_price,
          purchaseCurrency: values.purchase_currency,
          recordedByUserId: currentUser.id,
          notes: values.notes,
        },
      });

      if (result?.success) {
        toast.success(
          `Batch created successfully. ${values.quantity_received} units of ${selectedDrug.generic_name} added to inventory.`,
        );

        // Reset form but keep the drug and clinic selected
        batchForm.reset({
          ...DEFAULT_BATCH_VALUES,
          clinic_id: values.clinic_id,
        });

        // Reload batches
        const batchesResult = await getBatchesByDrug({
          data: { drugId: selectedDrug.id, onlyAvailable: false },
        });
        setExistingBatches(Result.getOrElse(batchesResult, []));
      } else {
        toast.error(result?.error || "Failed to create batch");
      }
    } catch (error) {
      Logger.error({ msg: "Error creating batch:", error });
      toast.error("Failed to create batch and add to inventory");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl">
        <div className="flex items-center gap-2 mb-2">
          <Package className="h-6 w-6" />
          <h1 className="text-2xl font-bold">Add Inventory via Batch</h1>
        </div>
        <p className="text-muted-foreground mb-6">
          Add new products to your clinic's inventory by creating batches. Each
          batch represents a shipment or purchase of drugs.
        </p>

        {/* Drug Selection/Details Section */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Drug Information</CardTitle>
            <CardDescription>
              {isExistingDrug
                ? "Adding batches for this drug"
                : "Select a drug from the catalogue to add batches"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!isExistingDrug ? (
              <div className="space-y-4">
                <DrugSearchSelect
                  label="Select Drug"
                  withAsterisk
                  value={selectedDrug?.id || ""}
                  onChange={handleDrugSelect}
                  isMulti={false}
                  clearable={false}
                  placeholder="Search for a drug in the catalogue"
                />
              </div>
            ) : null}

            {selectedDrug && (
              <div className="mt-4 space-y-3">
                {!isExistingDrug && <Separator />}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Generic Name
                    </p>
                    <p className="font-medium">{selectedDrug.generic_name}</p>
                  </div>
                  {selectedDrug.brand_name && (
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Brand Name
                      </p>
                      <p className="font-medium">{selectedDrug.brand_name}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">Form</p>
                    <p className="font-medium">{selectedDrug.form}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Strength</p>
                    <p className="font-medium">
                      {selectedDrug.dosage_quantity}
                      {selectedDrug.dosage_units}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Route</p>
                    <p className="font-medium">{selectedDrug.route}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Sale Price</p>
                    <p className="font-medium">
                      {selectedDrug.sale_currency} {selectedDrug.sale_price}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  {selectedDrug.is_controlled && (
                    <Badge variant="destructive">Controlled</Badge>
                  )}
                  {selectedDrug.requires_refrigeration && (
                    <Badge variant="secondary">Requires Refrigeration</Badge>
                  )}
                  {selectedDrug.is_active ? (
                    <Badge variant="default">Active</Badge>
                  ) : (
                    <Badge variant="outline">Inactive</Badge>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Batch Creation Form */}
        {selectedDrug && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Create New Batch</CardTitle>
              <CardDescription>
                Add a new batch to create inventory for this drug
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...batchForm}>
                <form
                  onSubmit={batchForm.handleSubmit(handleCreateBatch)}
                  className="space-y-4"
                >
                  <div className="grid grid-cols-2 gap-4">
                    {/* Clinic Selection */}
                    <FormField
                      control={batchForm.control}
                      name="clinic_id"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Clinic *</FormLabel>
                          <FormControl>
                            <SelectInput
                              data={clinics?.map((clinic) => ({
                                label: clinic.name
                                  ? clinic.name
                                  : "Unnamed Clinic",
                                value: clinic.id,
                              }))}
                              value={field.value}
                              onChange={field.onChange}
                              placeholder="Select a clinic"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Batch Number */}
                    <FormField
                      control={batchForm.control}
                      name="batch_number"
                      render={({ field: { value, onChange } }) => (
                        <FormItem>
                          <FormLabel>Batch Number *</FormLabel>
                          <FormControl>
                            {/*<Input
                              {...field}
                            />*/}
                            <Creatable
                              isClearable
                              placeholder="Enter batch number"
                              isSearchable
                              options={batchNumberOptions}
                              formatCreateLabel={(item) => `New Batch: ${item}`}
                              // value={value}
                              onChange={(field) => {
                                if (field?.value) {
                                  Logger.log({ value });
                                  onChange(field.value.trim());
                                } else {
                                  onChange("");
                                }
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Expiry Date */}
                    <FormField
                      control={batchForm.control}
                      name="expiry_date"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Expiry Date *</FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button
                                  variant={"outline"}
                                  className={cn(
                                    "w-full pl-3 text-left font-normal",
                                    !field.value && "text-muted-foreground",
                                  )}
                                >
                                  {field.value ? (
                                    format(field.value, "PPP")
                                  ) : (
                                    <span>Pick a date</span>
                                  )}
                                  <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent
                              className="w-auto p-0"
                              align="start"
                            >
                              <Calendar
                                mode="single"
                                selected={field.value || undefined}
                                onSelect={field.onChange}
                                disabled={(date) =>
                                  date <
                                  new Date(new Date().setHours(0, 0, 0, 0))
                                }
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Manufacture Date */}
                    <FormField
                      control={batchForm.control}
                      name="manufacture_date"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Manufacture Date</FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button
                                  variant={"outline"}
                                  className={cn(
                                    "w-full pl-3 text-left font-normal",
                                    !field.value && "text-muted-foreground",
                                  )}
                                >
                                  {field.value ? (
                                    format(field.value, "PPP")
                                  ) : (
                                    <span>Pick a date (optional)</span>
                                  )}
                                  <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent
                              className="w-auto p-0"
                              align="start"
                            >
                              <Calendar
                                mode="single"
                                selected={field.value || undefined}
                                onSelect={field.onChange}
                                disabled={(date) => date > new Date()}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* Quantity */}
                  <FormField
                    control={batchForm.control}
                    name="quantity_received"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Quantity Received *</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="1"
                            {...field}
                            onChange={(e) =>
                              field.onChange(parseInt(e.target.value) || 0)
                            }
                            placeholder="Number of units in this batch"
                          />
                        </FormControl>
                        <FormDescription>
                          This quantity will be added to the clinic's inventory
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Supplier */}
                  <FormField
                    control={batchForm.control}
                    name="supplier_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Supplier Name</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Enter supplier name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-4">
                    {/* Purchase Price */}
                    <FormField
                      control={batchForm.control}
                      name="purchase_price"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Purchase Price per Unit</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              {...field}
                              onChange={(e) =>
                                field.onChange(parseFloat(e.target.value) || 0)
                              }
                              placeholder="0.00"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Currency */}
                    <FormField
                      control={batchForm.control}
                      name="purchase_currency"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Currency</FormLabel>
                          <FormControl>
                            <SelectInput
                              data={currencyCodesOptions}
                              value={field.value}
                              onChange={field.onChange}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* Notes */}
                  <FormField
                    control={batchForm.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Notes</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            placeholder="Add any additional notes about this batch (optional)"
                            rows={3}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Action Buttons */}
                  <div className="flex justify-end gap-4 pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        navigate({ to: "/app/inventory/clinic-inventory" })
                      }
                    >
                      Back to Inventory
                    </Button>
                    <Button type="submit" disabled={isLoading}>
                      {isLoading
                        ? "Adding to Inventory..."
                        : "Add to Inventory"}
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {/* Existing Batches Table */}
        {selectedDrug && existingBatches.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Existing Batches</CardTitle>
              <CardDescription>
                Previously created batches for {selectedDrug.generic_name}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch Number</TableHead>
                    <TableHead>Expiry Date</TableHead>
                    <TableHead>Quantity Remaining</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {existingBatches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell className="font-medium">
                        {batch.batch_number}
                      </TableCell>
                      <TableCell>
                        {format(new Date(batch.expiry_date), "MM/dd/yyyy")}
                      </TableCell>
                      <TableCell>{batch.quantity_remaining} units</TableCell>
                      <TableCell>{batch.supplier_name || "-"}</TableCell>
                      <TableCell>
                        {batch.quantity_remaining > 0 ? (
                          <Badge variant="default">Available</Badge>
                        ) : (
                          <Badge variant="outline">Depleted</Badge>
                        )}
                        {new Date(batch.expiry_date) < new Date() && (
                          <Badge variant="destructive" className="ml-2">
                            Expired
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Remove Drug From Clinic */}
        {selectedDrug && (
          <Card className="mt-6 border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">
                Remove From Clinic
              </CardTitle>
              <CardDescription>
                Destroy a single clinic's stock of{" "}
                {selectedDrug.generic_name} and take the product off that
                clinic's shelves.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-w-sm">
                <SelectInput
                  label="Clinic"
                  data={clinics.map((clinic) => ({
                    label: clinic.name ? clinic.name : "Unnamed Clinic",
                    value: clinic.id,
                  }))}
                  value={removalClinicId}
                  onChange={(value) => setRemovalClinicId(value || "")}
                  placeholder="Select a clinic"
                />
              </div>

              {removalClinicId && removalStock && (
                <p className="text-sm text-muted-foreground">
                  {describeClinicStock(
                    removalStock,
                    selectedDrug.generic_name,
                    removalClinicName,
                  )}
                </p>
              )}

              <Button
                type="button"
                variant="destructive"
                disabled={
                  !removalClinicId ||
                  !removalStock ||
                  removalStock.batch_count === 0
                }
                onClick={() => setIsRemoveDialogOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                Remove from clinic
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {selectedDrug && (
        <Dialog
          open={isRemoveDialogOpen}
          onOpenChange={(open) => !isRemoving && setIsRemoveDialogOpen(open)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Remove {selectedDrug.generic_name} from {removalClinicName}?
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-3 text-sm">
                  <p>
                    This destroys the{" "}
                    {removalStock?.destroyable_quantity ?? 0} units held at{" "}
                    {removalClinicName} and takes the product off that clinic's
                    shelves. It cannot be undone.
                  </p>
                  {(removalStock?.reserved_quantity ?? 0) > 0 && (
                    <p>
                      {removalStock?.reserved_quantity} units reserved for
                      prescriptions already in flight are kept and stay
                      dispensable.
                    </p>
                  )}
                  <p>
                    Medications already prescribed or dispensed are not
                    affected. The drug stays in the drug catalogue and its stock
                    at other clinics is untouched.
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isRemoving}
                onClick={() => setIsRemoveDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={isRemoving}
                onClick={handleRemoveFromClinic}
              >
                {isRemoving ? "Removing..." : "Remove from clinic"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
