// import { getCookieToken } from '@/lib/auth/request'
import { AppSidebar, navData } from "@/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  createFileRoute,
  Outlet,
  redirect,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import React from "react";
// import { createServerFileRoute } from '@tanstack/react-start/server'
import { getCurrentUser } from "@/lib/server-functions/auth";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { Result } from "@/lib/result";
import { Logger } from "@hikmahealth/js-utils";
import { getDefaultCredentialStatusFn } from "@/lib/server-functions/setup";
import { DefaultCredentialBanner } from "@/components/setup/default-credential-banner";
import type { DefaultCredentialStatus } from "@/lib/setup/default-credential";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (!user) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: RouteComponent,
  loader: async () => {
    const user = await getCurrentUser();
    const [clinics, defaultCredential] = await Promise.all([
      getAllClinics(),
      loadDefaultCredentialStatus(user?.role),
    ]);
    return {
      currentUser: user,
      clinics: Result.getOrElse(clinics, []),
      defaultCredential,
    };
  },
});

/** Only admins are told; a failed check hides the warning rather than the portal. */
async function loadDefaultCredentialStatus(
  role: string | undefined,
): Promise<DefaultCredentialStatus | null> {
  if (role !== "admin" && role !== "super_admin") return null;
  try {
    return await getDefaultCredentialStatusFn();
  } catch (error) {
    Logger.error({ msg: "Could not check for the default login", error });
    return null;
  }
}

function RouteComponent() {
  const { currentUser, clinics, defaultCredential } = Route.useLoaderData();
  const handleSignOut = () => {
    if (window.confirm("Are you sure you want to sign out?")) {
      fetch(`/api/auth/sign-out`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then(() => {
          // Redirect to login page
          window.location.href = "/";
        })
        .catch((error) => {
          Logger.error({ msg: "Error during sign-out:", error });
        });
    }
  };

  const route = useRouter();

  // FIXME: The breadcrumbs dont automatically update when navigated into a separate screen whithout a full screen reload.
  // route.subscribe() should allow this subscription
  const breadcrumbs = getBreadcrumbs(
    route.latestLocation.pathname,
    navData.navMain,
  );

  return (
    <SidebarProvider>
      {currentUser && (
        <AppSidebar
          currentUser={currentUser}
          clinics={clinics}
          handleSignOut={handleSignOut}
        />
      )}
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-4"
            />
            <Breadcrumb>
              <BreadcrumbList>
                {breadcrumbs.map((crumb, index) => (
                  <React.Fragment key={crumb.url || crumb.name}>
                    {index > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem>
                      {index === breadcrumbs.length - 1 ? (
                        <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink href={crumb.url || "#"}>
                          {crumb.name}
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </React.Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        <div className="px-8">
          {defaultCredential?.kind === "in-use" && (
            <DefaultCredentialBanner userId={defaultCredential.userId} />
          )}
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Get friendly named breadcrumbs
 * @param {string} path - current pathname
 * @param {typeof navData.navMain} items - navigation items
 */
function getBreadcrumbs(path: string, items: typeof navData.navMain) {
  // If path is just /app, return Dashboard
  if (path === "/app") {
    return [{ name: "Dashboard", url: "/app" }];
  }

  const breadcrumbs: { name: string; url: string }[] = [];
  const pathParts = path.split("/").filter(Boolean);

  // Skip the "app" part as it's the base
  if (pathParts[0] === "app") {
    pathParts.shift();
  }

  if (pathParts.length === 0) {
    return breadcrumbs;
  }

  // First level - find the main section (e.g., "patients")
  const mainSection = pathParts[0];
  const mainItem = items.find((item) => {
    // Check if this main item has a matching URL
    if (item.url === `/app/${mainSection}`) {
      return true;
    }

    // Check if any of its subitems have a matching URL
    if (
      item.items &&
      item.items.some((subItem) =>
        subItem.url.startsWith(`/app/${mainSection}`),
      )
    ) {
      return true;
    }

    return false;
  });

  if (mainItem) {
    breadcrumbs.push({
      name: mainItem.title,
      url: mainItem.url !== "#" ? mainItem.url : `/app/${mainSection}`,
    });

    // If we have a deeper path, look for matching subitems
    if (pathParts.length > 1 && mainItem.items) {
      const fullSubPath = `/app/${pathParts.join("/")}`;
      const subItem = mainItem.items.find((item) => item.url === fullSubPath);

      if (subItem) {
        breadcrumbs.push({
          name: subItem.title,
          url: subItem.url,
        });
      } else {
        // If no exact match found, just add the subpath as is
        breadcrumbs.push({
          name: pathParts.slice(1).join("/"),
          url: fullSubPath,
        });
      }
    }
  } else {
    // If no match found in main items, just return the path as is
    breadcrumbs.push({
      name: mainSection,
      url: `/app/${mainSection}`,
    });
  }

  return breadcrumbs;
}
