import { createMiddleware } from "@tanstack/react-start";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";

// Define the schema for requests with authorization
const authSchema = z.object({
  headers: z
    .object({
      authorization: z.string().optional(),
    })
    .optional(),
});

// Define the user type
type User = {
  id: string;
  email: string;
  role: string;
};

// Mock database function to verify token and get user
// In a real application, replace this with your actual database query
const getUserFromToken = async (token: string): Promise<User | null> => {
  // Replace this with your actual database query
  // Example using a hypothetical database client:
  // return db.users.findFirst({ where: { token } })

  // For now, we'll just return a mock user if the token exists
  if (token) {
    return {
      id: "1",
      email: "user@example.com",
      role: "admin",
    };
  }
  return null;
};

// Create the authentication middleware
export const authMiddleware = createMiddleware({ type: "function" })
  .validator(zodValidator(authSchema))
  .server(async ({ next, data }) => {
    // Extract the authorization header
    const authHeader = data.headers?.authorization;

    if (!authHeader) {
      // No authorization header, return unauthorized
      throw new Error("Unauthorized: No authorization header provided");
    }

    // Check if it's a bearer token
    if (!authHeader.startsWith("Bearer ")) {
      throw new Error("Unauthorized: Invalid authorization format");
    }

    // Extract the token
    const token = authHeader.replace("Bearer ", "");

    // Verify the token and get the user
    const user = await getUserFromToken(token);

    if (!user) {
      throw new Error("Unauthorized: Invalid token");
    }

    // Continue with the authenticated user in context
    return next({
      context: {
        user,
      },
    });
  });

// Optional: Create a middleware for role-based authorization
export const requireRole = (allowedRoles: string[]) => {
  return createMiddleware({ type: "function" })
    .middleware([authMiddleware])
    .server(async ({ next, context }) => {
      const user = context.user as User;

      if (!allowedRoles.includes(user.role)) {
        throw new Error(
          `Forbidden: Required role ${allowedRoles.join(" or ")}`,
        );
      }

      return next();
    });
};

// Helper to get the authenticated user from context
export const getUser = (context: any): User => {
  if (!context.user) {
    throw new Error("User not authenticated");
  }
  return context.user as User;
};
