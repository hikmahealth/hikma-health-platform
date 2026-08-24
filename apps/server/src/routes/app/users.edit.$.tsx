import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import User from "@/models/user";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "@tanstack/react-router";
import { Logger } from "@hikmahealth/js-utils";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { Result } from "@/lib/result";
import upperFirst from "lodash/upperFirst";
import { getCurrentUserId } from "@/lib/server-functions/auth";
import { toast } from "sonner";
import { v1 as uuidV1 } from "uuid";
import { Either, Schema, Option } from "effect";
import { permissionsMiddleware } from "@/middleware/auth";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
  currentUserHasRole,
  getUserById,
  resetUserPassword,
} from "@/lib/server-functions/users";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import If from "@/components/if";
import { useImmerReducer } from "use-immer";

const updateUser = createServerFn({ method: "POST" })
  .validator(
    (data: {
      id: string;
      user: Omit<
        User.EncodedT,
        | "hashed_password"
        | "created_at"
        | "updated_at"
        | "last_modified"
        | "server_created_at"
        | "deleted_at"
      >;
    }) => data,
  )
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (!context.userId) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "updateUser",
      });
    }

    await UserClinicPermissions.API.isAuthorizedWithClinic(
      data.user.clinic_id,
      "is_clinic_admin",
    );

    const res = await User.API.update(data.id, data.user);
    return res;
  });

const registerUser = createServerFn({ method: "POST" })
  .validator((data: { user: User.EncodedT; creatorId: string }) => ({
    user: data.user,
    creatorId: data.creatorId,
  }))
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (!context.userId) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "registerUser",
      });
    }

    await UserClinicPermissions.API.isAuthorizedWithClinic(
      data.user.clinic_id,
      "is_clinic_admin",
    );

    // Only a super admin may create a super admin.
    if (
      context.role !== User.ROLES.SUPER_ADMIN &&
      data.user.role === User.ROLES.SUPER_ADMIN
    ) {
      return Promise.reject({
        message:
          "Unauthorized: Insufficient permissions. A non super admin cannot create a super admin user",
      });
    }

    const res = await User.API.create(data.user, data.creatorId);
    return res;
  });

const userFormSchema = Schema.Struct({
  name: Schema.NonEmptyTrimmedString,
  email: Schema.NonEmptyTrimmedString,
  clinic_id: Schema.OptionFromNullOr(Schema.String),
  role: User.RoleSchema,
  password: Schema.OptionFromNullOr(Schema.String),
});

type UserFormValues = typeof userFormSchema.Encoded;

export const Route = createFileRoute("/app/users/edit/$")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const userId = params._splat === "new" ? null : params._splat;
    return {
      user: await getUserById({ data: { id: userId } }),
      clinics: Result.getOrElse(await getAllClinics(), []),
      currentUserId: await getCurrentUserId(),
      isSuperAdmin: await currentUserHasRole({ data: { role: "super_admin" } }),
    };
  },
});

function RouteComponent() {
  const { user, clinics, currentUserId, isSuperAdmin } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const userId = Route.useParams()._splat;
  const isEditMode = Boolean(userId && user);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<UserFormValues>({
    // resolver: userFormSchema.resolve(userFormSchema),
    defaultValues: {
      name: user?.name || "",
      email: user?.email || "",
      role: user?.role || undefined,
      clinic_id: user?.clinic_id || undefined,
      password: "",
    },
  });

  const onSubmit = async (data: UserFormValues) => {
    setIsSubmitting(true);
    try {
      if (isEditMode && userId && typeof userId === "string") {
        await updateUser({ data: { id: userId, user: data } });
        navigate({ to: "/app/users" });
        toast.success("User updated successfully");
      } else {
        const newUser = User.UserSchema.make({
          id: uuidV1(),
          name: data.name,
          role: data.role,
          email: data.email,
          hashed_password: data.password as string,
          instance_url: Option.none(),
          clinic_id: Option.fromNullable(data.clinic_id),
          is_deleted: false,
          updated_at: new Date(),
          last_modified: new Date(),
          server_created_at: new Date(),
          deleted_at: Option.none(),
          created_at: new Date(),
        });
        const res = Schema.encodeUnknownEither(User.UserSchema)(newUser);
        Either.match(res, {
          onLeft: (error) => {
            Logger.error({ msg: "Failed to encode user:", error });
            toast.error("Failed to create user");
          },
          onRight: (user) => {
            registerUser({
              data: {
                user,
                creatorId: currentUserId || "",
              },
            })
              .then(() => {
                toast.success("User created successfully");
                navigate({ to: "/app/users" });
              })
              .catch((error) => {
                Logger.error({ msg: "Failed to create user:", error });
                toast.error(error.message);
              });
          },
        });
      }
    } catch (error) {
      Logger.error({ msg: "Error submitting form:", error });
      toast.error("Failed to create user");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">
          {isEditMode ? "Edit User" : "Create New User"}
        </h1>
      </div>

      <div className="max-w-xl">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-6"
            autoComplete="off"
            autoSave="off"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter user name" {...field} />
                  </FormControl>
                  <FormDescription>
                    The user's full name as it will appear in the system.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoCapitalize="none"
                      aria-autocomplete="none"
                      autoComplete="off"
                      autoCorrect="off"
                      autoSave="off"
                      placeholder="Enter email address"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The email address will be used for login and notifications.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="clinic_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Clinic</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value || undefined}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a clinic" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {clinics?.map((clinic) => (
                        <SelectItem key={clinic.id} value={clinic.id}>
                          {clinic.name || "Unnamed Clinic"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    The role determines what permissions the user will have.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="role"
              disabled={currentUserId === userId}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Role{" "}
                    {currentUserId === userId
                      ? "(Cannot be changed for current user)"
                      : ""}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline">?</Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          Registrar can only register patients and cannot access
                          patient records.
                        </p>
                        <p>
                          Providers can view medical history and access patient
                          records.
                        </p>
                        <p>
                          Admins can view medical history, access patient
                          records, and manage users.
                        </p>
                        <p>
                          Superadmins can perform all actions and have full
                          access to the system.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                    disabled={currentUserId === userId}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {User.roles.map((role) => (
                        <SelectItem key={role} value={role}>
                          {upperFirst(role)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    The role determines what permissions the user will have.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {!isEditMode && (
              <FormField
                control={form.control}
                name="password"
                disabled={currentUserId === userId}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        disabled={currentUserId === userId}
                        autoCapitalize="none"
                        aria-autocomplete="none"
                        autoComplete="off"
                        autoCorrect="off"
                        autoSave="off"
                        placeholder={
                          isEditMode
                            ? "Leave blank to keep current password"
                            : "Enter password"
                        }
                        {...field}
                        value={field.value || ""}
                      />
                    </FormControl>
                    <FormDescription>
                      {isEditMode
                        ? "Only fill this if you want to change the password."
                        : "The password must be secure."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <div className="flex justify-end gap-4">
              <Button type="button" variant="outline" asChild>
                <Link to="/app/users/">Cancel</Link>
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? "Saving..."
                  : isEditMode
                    ? "Update User"
                    : "Create User"}
              </Button>
            </div>
          </form>
        </Form>
        <hr className="my-8" />
      </div>

      <If show={isEditMode && isSuperAdmin && user !== null}>
        <UserPasswordResetForm userId={user?.id || ""} />
      </If>
    </div>
  );
}

type PasswordForm = {
  password: string;
  confirmPassword: string;
};

type PasswordFieldAction =
  | {
      type: "SET_PASSWORD" | "SET_CONFIRM_PASSWORD";
      payload: string;
    }
  | {
      type: "RESET";
    };

function reducer(state: PasswordForm, action: PasswordFieldAction) {
  switch (action.type) {
    case "SET_PASSWORD":
      return { ...state, password: action.payload };
    case "SET_CONFIRM_PASSWORD":
      return { ...state, confirmPassword: action.payload };
    case "RESET":
      return { password: "", confirmPassword: "" };
    default:
      return state;
  }
}

function UserPasswordResetForm({ userId }: { userId: string }) {
  const [passwordFields, dispatch] = useImmerReducer(reducer, {
    password: "",
    confirmPassword: "",
  } as PasswordForm);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSave = () => {
    if (passwordFields.password !== passwordFields.confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    if (!passwordFields.password) {
      toast.error("Password cannot be empty");
      return;
    }

    const confirmed = window.confirm(
      "Are you sure you want to reset the password?",
    );

    if (confirmed) {
      setIsSubmitting(true);
      resetUserPassword({
        data: { password: passwordFields.password, userId },
      })
        .then(() => {
          toast.success("Password reset successfully");
          dispatch({ type: "RESET" });
        })
        .catch((error) => {
          Logger.error({ msg: "Failed to reset password:", error });
          toast.error("Failed to reset password");
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    }
  };

  if (!userId) {
    return null;
  }

  return (
    <div className="max-w-xl pt-4 space-y-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl">Change Password</h1>
      </div>

      <Input
        label="New Password"
        type="password"
        placeholder="Enter new password"
        value={passwordFields.password}
        onChange={(e) =>
          dispatch({ type: "SET_PASSWORD", payload: e.target.value })
        }
      />
      <Input
        label="Confirm Password"
        type="password"
        placeholder="Confirm new password"
        value={passwordFields.confirmPassword}
        onChange={(e) =>
          dispatch({ type: "SET_CONFIRM_PASSWORD", payload: e.target.value })
        }
      />

      <div className="flex justify-end gap-4">
        <Button type="button" onClick={handleSave} disabled={isSubmitting}>
          {isSubmitting ? "Updating..." : "Update Password"}
        </Button>
      </div>
    </div>
  );
}
