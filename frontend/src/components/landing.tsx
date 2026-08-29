import { CardTitle, CardDescription, CardHeader, CardContent, Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useState, useEffect, useRef } from "react"
import axios from "axios"

const rawBackendUrl = import.meta.env.VITE_BACKEND_UPLOAD_URL || "http://localhost:3000";
const BACKEND_UPLOAD_URL = rawBackendUrl.trim().replace(/\/+$/, "");

const rawRequestHandlerUrl = import.meta.env.VITE_REQUEST_HANDLER_URL || "http://localhost:3001";
const REQUEST_HANDLER_URL = rawRequestHandlerUrl.trim().replace(/\/+$/, "");

interface LogMessage {
  log: string;
  type: "stdout" | "stderr" | "info";
  timestamp: string;
  status?: string;
}

export function Landing() {
  const [repoUrl, setRepoUrl] = useState("");
  const [rootDirectory, setRootDirectory] = useState("");
  const [deploymentType, setDeploymentType] = useState("auto");
  const [uploadId, setUploadId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // 1. On Initial Page Mount: Check URL Query Parameter ?id=... or localStorage
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const queryId = urlParams.get("id");
    const savedId = localStorage.getItem("lastDeploymentId");
    
    const activeId = queryId || savedId;
    if (activeId) {
      setUploadId(activeId);
      axios.get(`${BACKEND_UPLOAD_URL}/status?id=${activeId}`)
        .then(res => setStatus(res.data.status))
        .catch(err => console.error("Error fetching initial status:", err));
    }
  }, []);

  // 2. Real-Time SSE Log Streaming Listener
  useEffect(() => {
    if (!uploadId) return;

    console.log(`[Frontend] Connecting to SSE log stream at ${BACKEND_UPLOAD_URL}/logs/${uploadId}...`);
    const eventSource = new EventSource(`${BACKEND_UPLOAD_URL}/logs/${uploadId}`);

    eventSource.onmessage = (event) => {
      try {
        const data: LogMessage = JSON.parse(event.data);
        setLogs((prev) => [...prev, data]);
        if (data.status) {
          setStatus(data.status);
        }
      } catch (err) {
        console.error("Error parsing SSE log event:", err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn("[Frontend] SSE connection closed or waiting:", err);
    };

    return () => {
      eventSource.close();
    };
  }, [uploadId]);

  // 3. Auto-scroll terminal to bottom on new logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleDeploy = async () => {
    if (!repoUrl) return;
    setUploading(true);
    setLogs([]);
    setErrorMessage("");
    setStatus("uploading");

    try {
      console.log(`[Frontend] Sending deploy request to ${BACKEND_UPLOAD_URL}/deploy...`);
      const res = await axios.post(`${BACKEND_UPLOAD_URL}/deploy`, {
        repoUrl,
        deploymentType,
        rootDirectory: rootDirectory.trim() || undefined,
      });

      const newId = res.data.id;
      setUploadId(newId);
      localStorage.setItem("lastDeploymentId", newId);
      window.history.pushState({ path: `/?id=${newId}` }, "", `/?id=${newId}`);
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message || "Failed to trigger deployment.";
      console.error(`[Frontend] Deployment error calling ${BACKEND_UPLOAD_URL}/deploy:`, err);
      setErrorMessage(`Error calling ${BACKEND_UPLOAD_URL}/deploy: ${msg}`);
      setStatus("failed");
    } finally {
      setUploading(false);
    }
  };

  const handleNewDeployment = () => {
    setUploadId("");
    setRepoUrl("");
    setRootDirectory("");
    setStatus("");
    setErrorMessage("");
    setLogs([]);
    setDeploymentType("auto");
    localStorage.removeItem("lastDeploymentId");
    window.history.replaceState({ path: window.location.pathname }, "", window.location.pathname);
  };

  const getDeployedUrls = () => {
    if (!uploadId) return { deployedUrl: "", apiUrl: "" };
    if (REQUEST_HANDLER_URL.includes("localhost")) {
      return {
        deployedUrl: `http://${uploadId}.localhost:3001/index.html`,
        apiUrl: `http://${uploadId}.localhost:3001/api/`,
      };
    }
    return {
      deployedUrl: `${REQUEST_HANDLER_URL}/index.html?id=${uploadId}`,
      apiUrl: `${REQUEST_HANDLER_URL}/api/?id=${uploadId}`,
    };
  };

  const { deployedUrl, apiUrl } = getDeployedUrls();

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader className="flex flex-row justify-between items-start">
          <div>
            <CardTitle className="text-xl">Deploy your GitHub Repository</CardTitle>
            <CardDescription>Enter a GitHub repository or subfolder URL to build and deploy to Edge CDN</CardDescription>
          </div>
          {uploadId && (
            <Button variant="outline" size="sm" onClick={handleNewDeployment}>
              + New Deployment
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="github-url">GitHub Repository URL</Label>
              <Input 
                id="github-url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)} 
                placeholder="https://github.com/username/repo or .../tree/main/frontend" 
                disabled={uploading || status === "uploading" || status === "building"}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="root-dir">Root / Subfolder Directory (Optional)</Label>
                <Input 
                  id="root-dir"
                  value={rootDirectory}
                  onChange={(e) => setRootDirectory(e.target.value)} 
                  placeholder="e.g. backend, packages/app" 
                  disabled={uploading || status === "uploading" || status === "building"}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="deploy-type">Framework Preset</Label>
                <select
                  id="deploy-type"
                  value={deploymentType}
                  onChange={(e) => setDeploymentType(e.target.value)}
                  disabled={uploading || status === "uploading" || status === "building"}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="auto">Auto Detect</option>
                  <option value="react">React / Vite</option>
                  <option value="nextjs">Next.js (SSG)</option>
                  <option value="express">Node.js / Express Serverless</option>
                  <option value="static">Static HTML</option>
                </select>
              </div>
            </div>

            <Button 
              onClick={handleDeploy} 
              disabled={uploading || !repoUrl || status === "uploading" || status === "building"} 
              className="w-full"
            >
              {uploading || status === "uploading" ? "Uploading Source Code..." : 
               status === "building" ? "Building in Isolated Sandbox..." : 
               status === "deployed" ? "Redeploy Repository" : 
               "Deploy Project"}
            </Button>
          </div>

          {/* Error Notice */}
          {errorMessage && (
            <div className="mt-4 p-3 rounded-lg border border-red-500/50 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 text-xs">
              <strong>Deployment Error:</strong> {errorMessage}
            </div>
          )}

          {/* Real-time Status Badge */}
          {status && (
            <div className="mt-4 flex items-center justify-between p-3 rounded-lg border bg-gray-100 dark:bg-gray-800">
              <div className="flex items-center space-x-2">
                <span className="text-sm font-semibold">Deployment Status:</span>
                <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium uppercase tracking-wider ${
                  status === "deployed" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-500" :
                  status === "building" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse border border-blue-500" :
                  status === "uploading" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-500" :
                  "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400 border border-rose-500"
                }`}>
                  {status}
                </span>
              </div>
              {uploadId && <span className="text-xs text-gray-500">ID: {uploadId}</span>}
            </div>
          )}

          {/* Terminal / Live Build Logs Stream */}
          {uploadId && (
            <div className="mt-4 space-y-2">
              <div className="flex justify-between items-center">
                <Label className="text-xs font-semibold uppercase tracking-wider text-gray-500">Real-Time Build Telemetry Logs</Label>
                {status === "building" && <span className="text-xs text-blue-500 animate-pulse">● Live streaming</span>}
              </div>
              <div 
                ref={logContainerRef}
                className="bg-black text-gray-200 font-mono text-xs p-4 rounded-lg h-56 overflow-y-auto border border-gray-800 shadow-inner flex flex-col space-y-1"
              >
                {logs.length === 0 ? (
                  <p className="text-gray-500 italic">Connecting to worker output stream...</p>
                ) : (
                  logs.map((msg, index) => (
                    <div key={index} className="flex items-start space-x-2">
                      <span className="text-gray-500 select-none">{msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ""}</span>
                      <span className={
                        msg.type === "stderr" ? "text-red-400" :
                        msg.type === "info" ? "text-emerald-400" :
                        "text-gray-300"
                      }>
                        {msg.log}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Deployed Success Links */}
          {status === "deployed" && (
            <div className="mt-6 p-4 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-500/30 rounded-xl space-y-3">
              <div className="flex items-center space-x-2 text-emerald-600 dark:text-emerald-400 font-medium">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <span>Application is Live on Edge CDN!</span>
              </div>
              
              <div className="space-y-2">
                <div>
                  <Label className="text-xs text-gray-500">Static / Frontend URL:</Label>
                  <div className="flex items-center space-x-2 mt-1">
                    <Input readOnly value={deployedUrl} className="text-xs font-mono bg-white dark:bg-gray-900" />
                    <Button size="sm" onClick={() => window.open(deployedUrl, "_blank")}>
                      Open
                    </Button>
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-gray-500">Serverless Dynamic API Route:</Label>
                  <div className="flex items-center space-x-2 mt-1">
                    <Input readOnly value={apiUrl} className="text-xs font-mono bg-white dark:bg-gray-900" />
                    <Button size="sm" variant="secondary" onClick={() => window.open(apiUrl, "_blank")}>
                      Test API
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
