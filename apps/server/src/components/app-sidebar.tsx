import * as React from "react";
import {
  LayoutDashboard,
  Users,
  UserPlus,
  Building2,
  Calendar,
  Pill,
  BarChart3,
  LogOut,
  FolderCog,
  LucideFormInput,
  LucideListChecks,
  Box,
  LucideSchool2,
  ClipboardEditIcon,
} from "lucide-react";

import { NavMain } from "@/components/nav-main";
import { NavProjects } from "@/components/nav-projects";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import type User from "@/models/user";
import type Clinic from "@/models/clinic";

// This is sample data.
export const navData = {
  user: {
    name: "shadcn",
    email: "m@example.com",
    avatar: "/avatars/shadcn.jpg",
  },
  // replace with clinics ?
  teams: [
    {
      name: "Hikma Health",
      // logo: GalleryVerticalEnd,
      logo: () => <img src="/logo187.png" alt="Hikma Health" />,
      plan: "Primary Clinic", // Replace with "Top level" or something like that
    },
    // {
    //   name: "Hikma Health South America Location",
    //   logo: AudioWaveform,
    //   plan: "Startup",
    // },
    // {
    //   name: "Hikma Health Africa Location",
    //   logo: Command,
    //   plan: "Free",
    // },
  ],
  navMain: [
    {
      title: "Dashboard",
      url: "/app",
      icon: LayoutDashboard,
      isActive: true,
      items: [],
    },
    {
      title: "Patients",
      url: "#",
      icon: Users,
      isActive: true,
      items: [
        {
          title: "Patients List",
          url: "/app/patients",
        },
        {
          title: "Register Patient",
          url: "/app/patients/register",
        },
        {
          title: "Customize Registration Form",
          url: "/app/patients/customize-registration-form",
        },
      ],
    },
    {
      title: "Event Forms",
      url: "#",
      icon: LucideListChecks,
      isActive: true,
      items: [
        {
          title: "Forms List",
          url: "/app/event-forms",
        },
        {
          title: "Register New Form",
          url: "/app/event-forms/edit",
        },
      ],
    },
    {
      title: "Users",
      url: "#",
      icon: UserPlus,
      isActive: true,
      items: [
        {
          title: "Users List",
          url: "/app/users",
        },
        {
          title: "New User",
          url: "/app/users/edit",
        },
      ],
    },
    {
      title: "Clinics",
      url: "#",
      icon: Building2,
      isActive: true,
      items: [
        {
          title: "Clinics List",
          url: "/app/clinics",
        },
        {
          title: "New Clinic",
          url: "/app/clinics/edit",
        },
      ],
    },
    {
      title: "Appointments",
      url: "#",
      icon: Calendar,
      isActive: true,
      items: [
        {
          title: "Appointments List",
          url: "/app/appointments",
        },
        {
          title: "New Appointment",
          url: "/app/appointments/edit",
        },
      ],
    },
    {
      title: "Inventory",
      url: "#",
      icon: Box,
      isActive: true,
      items: [
        {
          title: "Drug Catalogue",
          url: "/app/inventory/drug-catalogue",
        },
        {
          title: "Clinic Inventory",
          url: "/app/inventory/clinic-inventory",
        },
      ],
    },
    {
      title: "Prescriptions",
      url: "#",
      icon: Pill,
      isActive: true,
      items: [
        {
          title: "Prescriptions List",
          url: "/app/prescriptions",
        },
        {
          title: "New Prescription",
          url: "/app/prescriptions/edit",
        },
      ],
    },
    {
      title: "Education",
      url: "#",
      icon: LucideSchool2,
      isActive: true,
      items: [
        {
          title: "Content List",
          url: "/app/education",
          icon: BarChart3,
        },
        {
          title: "New Content",
          url: "/app/education/new/editor",
        },
      ],
    },
    {
      title: "Data Analysis",
      url: "#",
      icon: BarChart3,
      isActive: true,
      items: [
        {
          title: "Reports 🧪",
          url: "/app/reports",
          icon: BarChart3,
        },
        {
          title: "Explore Events",
          url: "/app/data/events",
        },
      ],
    },
    {
      title: "Settings",
      url: "#",
      icon: FolderCog,
      isActive: true,
      items: [
        {
          // Also carries the QR that points a mobile app at this server.
          title: "Devices",
          url: "/app/settings/devices",
        },
        {
          // Client-app layout editors live under this page rather than as their
          // own sidebar entries.
          title: "Configuration",
          url: "/app/settings/configurations",
        },
        // {
        //   title: "File Storage",
        //   url: "/app/settings/file-storage",
        // },
      ],
    },
    // {
    //   title: "Patient Entries",
    //   url: "/app/entries",
    //   icon: ClipboardEditIcon,
    // },
  ],
  projects: [
    // {
    //   name: "Initiative A for funder X",
    //   url: "#",
    //   icon: Frame,
    // },
  ],
};

type AppSidebarProps = {
  clinics: Clinic.EncodedT[];
  currentUser: User.EncodedT | null;
  handleSignOut: () => void;
} & React.ComponentProps<typeof Sidebar>;

const organizationLevelClinic = {
  id: "organization",
  name: "Hikma Health",
  // logo: GalleryVerticalEnd,
  logo: () => <img src="/logo187.png" alt="Hikma Health" />,
  plan: "Entire Organization", // Replace with "Top level" or something like that
};

export function AppSidebar({
  clinics,
  currentUser,
  handleSignOut,
  ...props
}: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher
          teams={[
            organizationLevelClinic,
            ...clinics.map((clinic) => ({
              id: clinic.id,
              name: clinic.name || "",
              logo: () => <img src="/logo187.png" alt="Hikma Health" />,
              // url: `/app/clinics/${clinic.id}`,
              plan: "",
            })),
          ]}
          onChangeActiveTeam={(id) => {
            if (id === organizationLevelClinic.id) {
              // Handle organization-level actions
            } else {
              // Handle clinic-level actions
            }
          }}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navData.navMain} handleSignOut={handleSignOut} />
        {/* <NavProjects projects={navData.projects} /> */}
      </SidebarContent>
      <SidebarFooter>
        {currentUser && <NavUser user={currentUser} />}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
