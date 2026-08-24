import { createFileRoute, useRouter } from "@tanstack/react-router";
import User from "@/models/user";
import { createServerFn } from "@tanstack/react-start";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
// import { getCookieToken } from "@/lib/auth/request";
// import Token from "@/models/token";
// import { Option } from "effect";
import If from "@/components/if";
import { getCurrentUserId } from "@/lib/server-functions/auth";
import { toast } from "sonner";
import {
  currentUserHasRole,
  getAllUsers,
  getClinicIdsWithUserPermission,
} from "@/lib/server-functions/users";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import { permissionsMiddleware } from "@/middleware/auth";
import { Logger } from "@hikmahealth/js-utils";

// const getCurrentUserId = createServerFn({ method: "GET" }).handler(async () => {
//   const tokenCookie = getCookieToken();
//   if (!tokenCookie) return null;

//   const userOption = await Token.getUser(tokenCookie);
//   return Option.match(userOption, {
//     onNone: () => null,
//     onSome: (user) => user.id,
//   });
// });

// const getAllUsers = createServerFn({ method: "GET" }).handler(async () => {
// const users = await User.API.getAll();
// return users;
// });

const deleteUser = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "deleteUser",
      });
    }
    return User.API.softDelete(data.id);
  });

export const Route = createFileRoute("/app/users/")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    clinicId:
      typeof search.clinicId === "string" ? search.clinicId : undefined,
  }),
  loaderDeps: ({ search: { clinicId } }) => ({ clinicId }),
  loader: async ({ deps }) => {
    const currentUserId = await getCurrentUserId();
    const allUsers = await getAllUsers();
    // Client-side scope: server fn returns the full list (no pagination yet),
    // so filtering here keeps the change minimal.
    const users = deps.clinicId
      ? allUsers.filter((u) => u.clinic_id === deps.clinicId)
      : allUsers;
    return {
      users,
      filteredClinicId: deps.clinicId,
      currentUserId,
      currentUserAdminClinics: await getClinicIdsWithUserPermission({
        data: {
          userId: currentUserId || "",
          permission: "is_clinic_admin",
        },
      }),
      isSuperAdmin: await currentUserHasRole({ data: { role: "super_admin" } }),
    };
  },
});

function RouteComponent() {
  const {
    users,
    filteredClinicId,
    currentUserId,
    isSuperAdmin,
    currentUserAdminClinics,
  } = Route.useLoaderData();
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this user?")) {
      return;
    }

    if (!isSuperAdmin) {
      toast.error("Only Super Admins can delete users.");
      return;
    }

    setIsDeleting(id);
    try {
      await deleteUser({ data: { id } });
      router.invalidate({ sync: true });
    } catch (error) {
      Logger.error({ msg: "Failed to delete user:", error });
      toast.error("Failed to delete user");
    } finally {
      setIsDeleting(null);
    }
  };

  const isUserClinicAdmin = (userId: string, clinicId: string) => {
    if (isSuperAdmin) return true;
    if (userId === currentUserId && currentUserAdminClinics.includes(clinicId))
      return true;
    return false;
  };

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Users</h1>
        <Button asChild>
          <Link to="/app/users/edit/$" params={{ _splat: "new" }}>
            Add New User
          </Link>
        </Button>
      </div>

      <If show={!!filteredClinicId}>
        <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <span>Filtered to staff in clinic {filteredClinicId}</span>
          <Link to="/app/users" search={{ clinicId: undefined }}>
            <Button variant="link" size="sm" className="p-0 h-auto">
              Clear filter
            </Button>
          </Link>
        </div>
      </If>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell>{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>{user.role}</TableCell>
                <TableCell>
                  {new Date(user.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <If
                    show={
                      isSuperAdmin ||
                      isUserClinicAdmin(
                        currentUserId || "",
                        user.clinic_id || "",
                      )
                    }
                  >
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/app/users/edit/$" params={{ _splat: user.id }}>
                        Edit
                      </Link>
                    </Button>
                  </If>
                  {/* Only allow super admins to manage permissions or delete users */}
                  <If show={isSuperAdmin && currentUserId !== user.id}>
                    <>
                      <Button variant="outline" size="sm" asChild>
                        <Link
                          to="/app/users/manage-permissions/$"
                          params={{ _splat: user.id }}
                        >
                          Permissions
                        </Link>
                      </Button>

                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(user.id)}
                        disabled={isDeleting === user.id}
                      >
                        {isDeleting === user.id ? "Deleting..." : "Delete"}
                      </Button>
                    </>
                  </If>
                </TableCell>
              </TableRow>
            ))}
            {users.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-4">
                  No users found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
