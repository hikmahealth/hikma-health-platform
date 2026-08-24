import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

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
import db from "@/db";
import Clinic from "@/models/clinic";
import { Logger } from "@hikmahealth/js-utils";
import { adminMiddleware, superAdminMiddleware } from "@/middleware/auth";

const formSchema = z.object({
  name: z.string().min(1, "Clinic name is required"),
  country: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

const getClinicById = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    const clinic = await db
      .selectFrom("clinics")
      .where("id", "=", data.id)
      .where("is_deleted", "=", false)
      .selectAll()
      .executeTakeFirst();

    return clinic;
  });

const saveClinic = createServerFn({ method: "POST" })
  .validator(
    (data: {
      id?: string;
      name: string;
      country?: string | null;
      city?: string | null;
      address?: string | null;
    }) => data,
  )
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    return await Clinic.save({
      id: data.id,
      name: data.name,
      country: data.country,
      city: data.city,
      address: data.address,
    });
  });

export const Route = createFileRoute("/app/clinics/edit/$")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const clinicId = params["_splat"];
    if (!clinicId || clinicId === "new") {
      return { clinic: null };
    }
    return { clinic: await getClinicById({ data: { id: clinicId } }) };
  },
});

function RouteComponent() {
  const navigate = useNavigate();
  const { clinic } = Route.useLoaderData();
  const params = Route.useParams();
  const clinicId = params._splat;
  const isEditing = !!clinicId && clinicId !== "new";

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: clinic?.name || "",
      country: clinic?.country || "",
      city: clinic?.city || "",
      address: clinic?.address || "",
    },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      await saveClinic({
        data: {
          id: clinic?.id || undefined,
          name: values.name,
          country: values.country,
          city: values.city,
          address: values.address,
        },
      });

      toast.success(
        isEditing
          ? "Clinic updated successfully"
          : "Clinic created successfully",
      );
      navigate({ to: "/app/clinics" });
    } catch (error) {
      Logger.error({ msg: "Error saving clinic:", error });
      toast.error("Failed to save clinic");
    }
  };

  return (
    <div className="container py-4">
      <div className="max-w-md">
        <h1 className="text-xl font-bold mb-2">
          {isEditing ? "Edit Clinic" : "Register New Clinic"}
        </h1>
        <p className="text-muted-foreground mb-6">
          {isEditing
            ? "Update the clinic information below"
            : "Enter the details for the new clinic"}
        </p>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Clinic Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter clinic name" {...field} />
                  </FormControl>
                  <FormDescription>
                    The name of the clinic as it will appear in the system
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="country"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Country</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter country (optional)" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>City</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter city (optional)" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter address (optional)" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate({ to: "/app/clinics" })}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isEditing ? "Update Clinic" : "Create Clinic"}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
