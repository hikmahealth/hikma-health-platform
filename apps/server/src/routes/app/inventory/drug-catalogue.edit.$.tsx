import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { v1 as uuidV1 } from "uuid";
import { toast } from "sonner";

import DrugCatalogue from "@/models/drug-catalogue";
import EventForm from "@/models/event-form";
import { getCurrentUser } from "@/lib/server-functions/auth";
import User from "@/models/user";
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
import { Checkbox } from "@/components/ui/checkbox";
import { SelectInput } from "@/components/select-input";
import { upperFirst } from "es-toolkit/compat";
import {
  getDrugById,
  saveDrug,
  updateDrug,
} from "@/lib/server-functions/drugs";
import { currencyCodesOptions } from "@/data/currencies";
import { Logger } from "@hikmahealth/js-utils";

const DEFAULT_FORM_VALUES: Partial<DrugCatalogue.ApiDrug> = {
  barcode: null,
  generic_name: "",
  brand_name: null,
  form: "",
  route: "",
  dosage_quantity: 0,
  dosage_units: "",
  manufacturer: null,
  sale_price: 0,
  sale_currency: "USD",
  min_stock_level: 0,
  max_stock_level: null,
  is_controlled: false,
  requires_refrigeration: false,
  is_active: true,
  notes: null,
  metadata: {},
  is_deleted: false,
};

export const Route = createFileRoute("/app/inventory/drug-catalogue/edit/$")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const drugId = params["_splat"];

    const result: {
      drug: DrugCatalogue.ApiDrug | null;
      currentUser: User.EncodedT | null;
    } = {
      drug: null,
      currentUser: null,
    };

    if (drugId && typeof drugId === "string" && drugId !== "new") {
      const drugData = await getDrugById({ data: { id: drugId } });
      result.drug = drugData || null;
    }

    result.currentUser = (await getCurrentUser()) as User.EncodedT | null;

    return result;
  },
});

function RouteComponent() {
  const { drug, currentUser } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  // Keyed off the loaded row, not the url: an id matching nothing leaves the
  // form on its defaults, so it is an add whatever the path said.
  const isEditing = drug !== null;

  const form = useForm<Partial<DrugCatalogue.ApiDrug>>({
    defaultValues: drug || DEFAULT_FORM_VALUES,
  });

  const onSubmit = async (values: Partial<DrugCatalogue.ApiDrug>) => {
    if (!currentUser) {
      toast.error("You must be logged in to save drugs");
      return;
    }

    try {
      if (drug) {
        // recorded_by_user_id rides along untouched: it names whoever entered
        // the drug, and the table has no separate last-edited-by column.
        await updateDrug({ data: { id: drug.id, drug: values } });
      } else {
        await saveDrug({
          data: {
            drug: {
              ...values,
              id: uuidV1(),
              recorded_by_user_id: currentUser.id,
            },
            isEdit: false,
          },
        });
      }

      toast.success(
        isEditing ? "Drug updated successfully" : "Drug created successfully",
      );
      navigate({ to: "/app/inventory/drug-catalogue", reloadDocument: true });
    } catch (error) {
      Logger.error({ msg: "Error saving drug:", error });
      toast.error("Failed to save drug");
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold mb-2">
          {isEditing ? "Edit Drug" : "Add New Drug to Catalogue"}
        </h1>
        <p className="text-muted-foreground mb-6">
          {isEditing
            ? "Update the drug information below"
            : "Enter the details for the new drug"}
        </p>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Basic Information Section */}
            <div className="space-y-4 border rounded-lg p-4">
              <h2 className="text-lg font-semibold">Basic Information</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="generic_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Generic Name *</FormLabel>
                      <FormDescription>
                        The generic (non-brand) name of the drug
                      </FormDescription>
                      <FormControl>
                        <Input {...field} value={field.value || ""} />
                      </FormControl>

                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="brand_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Brand Name</FormLabel>
                      <FormDescription>
                        The commercial brand name (optional)
                      </FormDescription>
                      <FormControl>
                        <Input {...field} value={field.value || ""} />
                      </FormControl>

                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="barcode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Barcode</FormLabel>
                      <FormDescription>
                        Product barcode for scanning
                      </FormDescription>
                      <FormControl>
                        <Input {...field} value={field.value || ""} />
                      </FormControl>

                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="manufacturer"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Manufacturer</FormLabel>

                      <FormDescription>
                        Drug manufacturer or pharmaceutical company
                      </FormDescription>
                      <FormControl>
                        <Input {...field} value={field.value || ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Drug Form and Dosage Section */}
            <div className="space-y-4 border rounded-lg p-4">
              <h2 className="text-lg font-semibold">Form and Dosage</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="form"
                  render={({ field }) => (
                    <SelectInput
                      label="Drug Form *"
                      data={EventForm.medicineForms.map((form) => ({
                        label: upperFirst(form),
                        value: form,
                      }))}
                      value={field.value || ""}
                      onChange={field.onChange}
                      clearable
                      className="w-full"
                      description="Physical form of the drug"
                    />
                  )}
                />

                <FormField
                  control={form.control}
                  name="route"
                  render={({ field }) => (
                    <SelectInput
                      label="Administration Route *"
                      data={EventForm.medicineRoutes.map((route) => ({
                        label: upperFirst(route),
                        value: route,
                      }))}
                      value={field.value || ""}
                      onChange={field.onChange}
                      clearable
                      className="w-full"
                      description="How the drug is administered"
                    />
                  )}
                />

                <FormField
                  control={form.control}
                  name="dosage_quantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Dosage Quantity *</FormLabel>
                      <FormDescription>Amount per dose</FormDescription>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          value={field.value || 0}
                          onChange={(e) =>
                            field.onChange(parseFloat(e.target.value) || 0)
                          }
                        />
                      </FormControl>

                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="dosage_units"
                  render={({ field }) => (
                    <SelectInput
                      label="Dosage Units *"
                      data={EventForm.doseUnits.map((unit) => ({
                        label: unit,
                        value: unit,
                      }))}
                      value={field.value || ""}
                      onChange={field.onChange}
                      clearable
                      className="w-full"
                      description="Units of measurement for dosage"
                    />
                  )}
                />
              </div>
            </div>

            {/* Pricing and Inventory Section */}
            <div className="space-y-4 border rounded-lg p-4">
              <h2 className="text-lg font-semibold">Pricing and Inventory</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="sale_price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sale Price *</FormLabel>
                      <FormDescription>
                        Unit price for this drug
                      </FormDescription>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          step="0.01"
                          value={field.value || 0}
                          onChange={(e) =>
                            field.onChange(parseFloat(e.target.value) || 0)
                          }
                        />
                      </FormControl>

                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="sale_currency"
                  render={({ field }) => (
                    <SelectInput
                      label="Currency"
                      data={currencyCodesOptions}
                      value={field.value || "USD"}
                      onChange={field.onChange}
                      className="w-full"
                      description="Currency for pricing"
                    />
                  )}
                />

                <FormField
                  control={form.control}
                  name="min_stock_level"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Minimum Stock Level</FormLabel>
                      <FormDescription>
                        Alert when stock falls below this level
                      </FormDescription>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          value={field.value || 0}
                          onChange={(e) =>
                            field.onChange(parseInt(e.target.value) || 0)
                          }
                        />
                      </FormControl>

                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="max_stock_level"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Maximum Stock Level</FormLabel>
                      <FormDescription>
                        Maximum recommended stock level
                      </FormDescription>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          value={field.value || ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value ? parseInt(e.target.value) : null,
                            )
                          }
                        />
                      </FormControl>

                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Storage and Control Section */}
            <div className="space-y-4 border rounded-lg p-4">
              <h2 className="text-lg font-semibold">Storage and Control</h2>

              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="is_controlled"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Controlled Substance</FormLabel>
                        <FormDescription>
                          This drug is a controlled substance requiring special
                          handling
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="requires_refrigeration"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Requires Refrigeration</FormLabel>
                        <FormDescription>
                          This drug must be stored in a refrigerated environment
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="is_active"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Active</FormLabel>
                        <FormDescription>
                          Drug is currently available for use and ordering
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Notes Section */}
            <div className="space-y-4 border rounded-lg p-4">
              <h2 className="text-lg font-semibold">Additional Information</h2>

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormDescription>
                      Additional notes or special instructions for this drug
                    </FormDescription>
                    <FormControl>
                      <Textarea
                        {...field}
                        value={field.value || ""}
                        rows={4}
                        placeholder="Enter any additional notes or special instructions..."
                      />
                    </FormControl>

                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Action Buttons */}
            <div className="flex justify-end space-x-4">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  navigate({ to: "/app/inventory/drug-catalogue" })
                }
              >
                Cancel
              </Button>
              <Button type="submit">
                {isEditing ? "Update Drug" : "Add Drug"}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
