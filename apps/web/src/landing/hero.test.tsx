import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Hero } from "./hero.tsx";

function show() {
  return render(<Hero />);
}

describe("the front page's hero", () => {
  it("states the positioning: describing, building and editing 3D", () => {
    show();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /describe 3d scenes\.\s*build, edit, iterate\./i,
    );
  });

  it("says what Vibe-VR is rather than gesturing at AI", () => {
    show();

    expect(screen.getByText(/conversational procedural construction layer/i)).toBeInTheDocument();
  });

  it("offers a primary way in and a secondary look at the demo", () => {
    show();

    expect(screen.getByRole("link", { name: "Start describing" })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    expect(screen.getByRole("link", { name: "See how it works" })).toHaveAttribute(
      "href",
      "#how-it-works",
    );
  });

  it("shows the sample scene, labelled as what it is", () => {
    show();

    expect(screen.getByRole("figure", { name: /sample chair model/i })).toBeInTheDocument();
  });

  it("says the chair is a sample, not something Vibe-VR generated", () => {
    show();

    expect(screen.getByText(/pictured: a sample 3d scene/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /cc-by 4\.0/i })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/",
    );
  });

  it("keeps the background layers behind the content and off the words", () => {
    const { container } = show();

    expect(screen.getByTestId("landing-doodles")).toHaveClass("z-0");
    expect(container.querySelector("[data-no-trail]")).toHaveClass("z-10");
  });

  it("offers no prompt box", () => {
    // A sentence typed here would have to survive an authentication redirect, and every step of
    // that is a place to lose it. The box lives in the workbench, behind the sign-in.
    show();

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
