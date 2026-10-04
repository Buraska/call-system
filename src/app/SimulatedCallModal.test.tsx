import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulatedCallModal } from "./SimulatedCallModal";

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded audio"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

describe("SimulatedCallModal", () => {
  const urlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:recording") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "call-123" }),
    });
  });
  afterEach(() => {
    if (urlDescriptor) Object.defineProperty(URL, "createObjectURL", urlDescriptor);
    else delete (URL as Partial<typeof URL>).createObjectURL;
    if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    else delete (URL as Partial<typeof URL>).revokeObjectURL;
    if (mediaDevicesDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    else delete (navigator as Partial<typeof navigator>).mediaDevices;
    stopTrack.mockReset();
    getUserMedia.mockReset();
    fetchMock.mockReset();
  });


  it("requires a recording, then uploads it and reports successful completion", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<SimulatedCallModal token="test-token" onClose={vi.fn()} onCreated={onCreated} />);

    const submit = screen.getByRole("button", { name: "Process as call" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Caller phone number"), "+37255551234");

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    expect(await screen.findByText(/Recording/)).toBeVisible();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(submit).toBeEnabled());
    expect(document.querySelector("audio.simulated-call-preview")).toHaveAttribute("src", "blob:recording");
    expect(stopTrack).toHaveBeenCalledOnce();

    await user.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "call-123" }));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/api/calls/simulate");
    expect(request.method).toBe("POST");
    expect((request.headers as Headers).get("Authorization")).toBe("Bearer test-token");
    expect(request.body).toBeInstanceOf(FormData);
    const body = request.body as FormData;
    expect(body.get("caller_phone")).toBe("+37255551234");
    expect(Number(body.get("duration_seconds"))).toBeGreaterThan(0);
    const audio = body.get("audio");
    expect(audio).toBeInstanceOf(File);
    expect((audio as File).size).toBeGreaterThan(0);
    expect((audio as File).name).toBe("call.webm");
  });
});
