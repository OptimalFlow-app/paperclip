import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { PrivacyPage } from "./06-full-product-pages.stories";
import { useDialog } from "@/context/DialogContext";
import { Button } from "@/components/ui/button";
import {
  mobile,
  choosePrivateTask,
  privacyDecorator,
  privacyParameters,
  StoryFrame,
} from "./PrivacyStory";

function Creation({
  parent = false,
  project = false,
  draft = false,
  taskTitle = "Prepare my board briefing",
}: {
  parent?: boolean;
  project?: boolean;
  draft?: boolean;
  taskTitle?: string;
}) {
  const { openNewIssue } = useDialog();
  const opened = useRef(false);
  const open = () =>
    openNewIssue({
      ...(draft
        ? {}
        : {
            title: parent
              ? "Research market benchmarks"
              : taskTitle,
          }),
      ...(parent
        ? {
            parentId: "privacy-root",
            parentIdentifier: "PAP-410",
            parentTitle: taskTitle,
          }
        : {}),
      ...(project ? { projectId: "project-private" } : {}),
    });
  useEffect(() => {
    open();
  }, [parent, project, draft, taskTitle]);
  return <PrivacyPage tasks />;
}
const meta = {
  title: "Private tasks/01 Creation",
  decorators: [privacyDecorator],
  parameters: { ...privacyParameters, docs: { description: { component: "Route /PAP/issues with the new-task composer. Choose Private task from +; the lock chip keeps the selection visible. Parent and project restrictions remain inherited. Example title is editable in Controls." } } },
  args: { taskTitle: "Prepare my board briefing" },
  argTypes: { taskTitle: { control: "text" } },
  render: (args) => <Creation {...args} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const OpenByDefault: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await page.findByRole("button", { name: "Add to composer" });
    await waitFor(() => expect(page.queryByTestId("composer-private-chip")).not.toBeInTheDocument());
  },
};
export const PrivacyInPlusMenu: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Add to composer" }));
    await expect(await page.findByTestId("composer-add-private")).toBeVisible();
  },
};
export const PrivateBeforeSaving: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await choosePrivateTask(page);
    await expect(await page.findByRole("button", { name: "Remove private task" })).toBeVisible();
  },
};
export const RemovePrivateChoice: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await choosePrivateTask(page);
    await userEvent.click(await page.findByRole("button", { name: "Remove private task" }));
    await waitFor(() => expect(page.queryByTestId("composer-private-chip")).not.toBeInTheDocument());
  },
};
export const ChildInheritsPrivacy: Story = {
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement.ownerDocument.body).findByRole("button", { name: "Private task" })).toBeDisabled();
  },
};
export const MobilePrivateChoice: Story = { ...PrivateBeforeSaving, globals: mobile };
export const MobilePlusMenu: Story = { ...PrivacyInPlusMenu, globals: mobile };
export const PrivateProject: Story = { render: () => <Creation project /> };
export const PersonalProject: Story = {
  parameters: { privacy: { personal: true } },
  render: () => <Creation project />,
};
export const RestoredPrivateDraft: Story = {
  parameters: { privacy: { draft: true } },
  render: () => <Creation draft />,
};
export const CreationFailure: Story = {
  parameters: { privacy: { failure: "create", draft: true } },
  render: () => <Creation draft />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Create task" }),
    );
    await expect(
      await page.findByText("The request could not be completed. Try again."),
    ).toBeVisible();
  },
};
export const MobilePrivateChild: Story = {
  globals: mobile,
  render: () => <Creation parent />,
};
export const LightPrivateDraft: Story = {
  globals: { theme: "light" },
  parameters: { privacy: { draft: true } },
  render: () => <Creation draft />,
};

export const ParentAccessLoading: Story = {
  parameters: { privacy: { loading: "parent" } },
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText("Checking parent access…")).toBeVisible();
    await expect(await page.findByRole("button", { name: "Create sub-task" })).toBeDisabled();
    await userEvent.click(await page.findByRole("button", { name: "Add to composer" }));
    await expect(page.queryByTestId("composer-add-private")).not.toBeInTheDocument();
  },
};
export const ParentAccessUnavailable: Story = {
  parameters: { privacy: { failure: "parent" } },
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText("Couldn't check parent access.")).toBeVisible();
    await expect(await page.findByRole("button", { name: "Create sub-task" })).toBeDisabled();
  },
};
export const RetryParentAccess: Story = {
  parameters: { privacy: { failure: "parent", retryOnce: true } },
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Retry" }));
    await expect(await page.findByRole("button", { name: "Private task" })).toBeDisabled();
    await expect(await page.findByRole("button", { name: "Create sub-task" })).toBeEnabled();
  },
};
export const MobileParentAccessUnavailable: Story = { ...ParentAccessUnavailable, globals: mobile };
