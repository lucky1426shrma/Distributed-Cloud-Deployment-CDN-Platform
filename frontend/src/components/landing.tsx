import { CardTitle, CardDescription, CardHeader, CardContent, Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useState, useEffect, useRef } from "react"
import axios from "axios"

const BACKEND_UPLOAD_URL = "http://localhost:3000";

interface LogMessage {
  log: string;
  type: "stdout" | "stderr" | "info";
  timestamp: string;
}

export function Landing() {
  const [repoUrl, setRepoUrl] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Connect to native browser Server-Sent Events (SSE) build log stream once uploadId is assigned
  useEffect(() => {
    if (!uploadId) return;

    const sseUrl = `${BACKEND_UPLOAD_URL}/logs?id=${uploadId}`;
    const eventSource = new EventSource(sseUrl);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.log) {
          setLogs((prev) => [...prev, data]);
        }
      } catch (err) {
        console.error("Failed to parse SSE log line:", err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn("SSE connection closed or reconnecting:", err);
    };

    // Poll deployment status
    const interval = setInterval(async () => {
      try {
        const response = await axios.get(`${BACKEND_UPLOAD_URL}/status?id=${uploadId}`);
        const currentStatus = response.data.status;
        setStatus(currentStatus);

        if (currentStatus === "deployed" || currentStatus === "failed") {
          clearInterval(interval);
          eventSource.close();
        }
      } catch (err) {
        console.error("Error fetching status:", err);
      }
    }, 1500);

    return () => {
      eventSource.close();
      clearInterval(interval);
    };
  }, [uploadId]);

  // Auto-scroll build log window to bottom
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleDeploy = async () => {
    if (!repoUrl) return;
    setUploading(true);
    setLogs([]);
    try {
      const res = await axios.post(`${BACKEND_UPLOAD_URL}/deploy`, { repoUrl });
      setUploadId(res.data.id);
      setStatus("uploaded");
    } catch (err: any) {
      alert(err.response?.data?.error || "Failed to trigger deployment.");
    } finally {
      setUploading(false);
    }
  };

  const deployedUrl = `http://${uploadId}.localhost:3001/index.html`;

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-xl">Deploy your GitHub Repository</CardTitle>
          <CardDescription>Enter the URL of your GitHub repository to build and deploy to Edge CDN</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="github-url">GitHub Repository URL</Label>
              <Input 
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)} 
                placeholder="https://github.com/username/repo" 
                disabled={uploading || !!uploadId}
              />
            </div>
            <Button 
              onClick={handleDeploy} 
              disabled={!repoUrl || uploading || !!uploadId} 
              className="w-full"
            >
              {uploadId ? `Deploying (${uploadId})` : uploading ? "Uploading Source Files..." : "Deploy Repository"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Terminal Live Build Log Viewer (Powered by Server-Sent Events SSE) */}
      {uploadId && (
        <Card className="w-full max-w-2xl mt-6 border border-gray-800 bg-gray-950 text-gray-100 font-mono shadow-2xl">
          <CardHeader className="border-b border-gray-800 pb-3">
            <div className="flex justify-between items-center">
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-green-400">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                Live Container Build Logs [{uploadId}] (SSE Stream)
              </CardTitle>
              <span className={`text-xs px-2 py-0.5 rounded font-bold uppercase ${
                status === "deployed" ? "bg-green-900 text-green-300" :
                status === "failed" ? "bg-red-900 text-red-300" :
                status === "building" ? "bg-blue-900 text-blue-300" : "bg-gray-800 text-gray-300"
              }`}>
                {status || "Initializing"}
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div 
              ref={logContainerRef}
              className="h-64 overflow-y-auto space-y-1 text-xs leading-relaxed p-2 rounded bg-black/50 border border-gray-900"
            >
              {logs.length === 0 ? (
                <div className="text-gray-500 italic">Connecting to live SSE build log stream...</div>
              ) : (
                logs.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span className="text-gray-600 select-none">
                      {item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : ""}
                    </span>
                    <span className={
                      item.type === "stderr" ? "text-red-400" :
                      item.type === "info" ? "text-cyan-400 font-bold" : "text-gray-200"
                    }>
                      {item.log}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Deployment Deployed URL Result */}
      {status === "deployed" && (
        <Card className="w-full max-w-2xl mt-6 border-green-500/50 bg-green-950/20">
          <CardHeader>
            <CardTitle className="text-xl text-green-400">🎉 Deployment Successful!</CardTitle>
            <CardDescription>Your site is live on the Edge CDN with sub-15ms response times.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="deployed-url">Live URL</Label>
              <Input id="deployed-url" readOnly type="url" value={deployedUrl} className="font-mono text-sm" />
            </div>
            <Button className="w-full bg-green-600 hover:bg-green-700 text-white" asChild>
              <a href={deployedUrl} target="_blank" rel="noopener noreferrer">
                Visit Deployed Website 🚀
              </a>
            </Button>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
