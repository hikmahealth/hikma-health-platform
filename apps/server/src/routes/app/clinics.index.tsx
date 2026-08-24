import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { superAdminMiddleware } from "@/middleware/auth";
import Clinic from "@/models/clinic";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  LucideArchive,
  LucideEdit,
  LucideTrash,
  LucideView,
} from "lucide-react";
import { toast } from "sonner";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { Result } from "@/lib/result";
import { Link } from "@tanstack/react-router";
import { Logger } from "@hikmahealth/js-utils";

const deleteClinic = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    return Clinic.softDelete(data.id);
  });

export const archiveClinic = createServerFn({ method: "POST" })
  .validator((data: { id: string; isArchived: boolean }) => data)
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    return Clinic.API.setArchivedStatus(data.id, data.isArchived);
  });

export const Route = createFileRoute("/app/clinics/")({
  component: RouteComponent,
  loader: async () => {
    const clinics = Result.getOrElse(await getAllClinics(), []);
    return { clinics };
  },
});

function RouteComponent() {
  const { clinics } = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();

  const handleEdit = (id: string) => {
    navigate({ to: `/app/clinics/edit/${id}` });
  };

  const handleOpen = (id: string) => {
    navigate({ to: `/app/clinics/${id}` });
  };

  const handleDelete = (id: string) => {
    return;
    if (!window.confirm("Are you sure you want to delete this clinic?")) {
      return;
    }

    deleteClinic({ data: { id } })
      .catch((error: any) => {
        Logger.error(error);
        toast.error(error.message);
      })
      .then(() => {
        toast.success("Clinic deleted successfully");
        router.invalidate({ sync: true });
      });
  };

  const handleArchive = (id: string) => {
    const usersCount =
      clinics.find((clinic) => clinic.id === id)?.users?.length || 0;
    if (usersCount > 0) {
      toast.error("Cannot archive a clinic with users");
      return;
    }
    if (!window.confirm("Are you sure you want to archive this clinic?")) {
      return;
    }

    archiveClinic({ data: { id, isArchived: true } })
      .catch((error: any) => {
        Logger.error({ error });
        toast.error(error.message);
      })
      .then(() => {
        toast.success("Clinic archived successfully");
        router.invalidate({ sync: true });
      });
  };

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Clinics</h1>
        <Button asChild>
          <Link to="/app/clinics/edit/$" params={{ _splat: "new" }}>
            Add Clinic
          </Link>
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {/*562367a0-7101-15et-94a6-f558757a6785*/}
              <TableHead>Name</TableHead>
              <TableHead>Users</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clinics?.map((clinic) => (
              <TableRow key={clinic.id} className="py-2">
                <TableCell>{clinic.name}</TableCell>
                <TableCell align="center">
                  {clinic?.users?.length || 0}
                </TableCell>
                <TableCell className="flex gap-4">
                  <Button
                    variant="outline"
                    onClick={() => handleOpen(clinic.id)}
                  >
                    <LucideView className="mr-2" />
                    Open
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleEdit(clinic.id)}
                  >
                    <LucideEdit className="mr-2" />
                    Edit
                  </Button>
                  {/* DELETE IS NOT ALLOWED */}
                  {/*<Button
                    variant="outline"
                    className="text-red-500"
                    onClick={() => handleDelete(clinic.id)}
                  >
                    <LucideTrash className="mr-2" />
                    Delete
                  </Button>*/}
                  <Button
                    variant="outline"
                    className="text-red-500"
                    onClick={() => handleArchive(clinic.id)}
                  >
                    <LucideArchive className="mr-2" />
                    Archive
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
