import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { BookingPage } from "./pages/BookingPage";
import { ManagePage } from "./pages/ManagePage";
import { DashboardPage } from "./pages/DashboardPage";
import { HomePage } from "./pages/HomePage";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/dashboard", element: <DashboardPage /> },
  { path: "/manage/:token", element: <ManagePage /> },
  // Public booking page: /{host}/{event-slug}
  { path: "/:host/:slug", element: <BookingPage /> },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </React.StrictMode>,
);
