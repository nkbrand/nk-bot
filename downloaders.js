const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const execPromise = util.promisify(exec);
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const YTDLP = "./yt-dlp";

async function downloadMedia(url) {
    const output = path.join(DOWNLOAD_DIR, `${Date.now()}_original.mp4`);
    const finalOutput = path.join(DOWNLOAD_DIR, `${Date.now()}_final.mp4`);

    try {
        // Step 1: Download
        const cmd = `${YTDLP} -f "best[ext=mp4]" -o "${output}" "${url}" --no-playlist --quiet --no-warnings --no-check-certificate 2>/dev/null`;
        await execPromise(cmd, { maxBuffer: 200 * 1024 * 1024 });

        if (!fs.existsSync(output) || fs.statSync(output).size === 0) return null;

        // Step 2: Boost Audio
        try {
            const boostCmd = `ffmpeg -i "${output}" -c:v copy -af "volume=2" "${finalOutput}" -y 2>/dev/null`;
            await execPromise(boostCmd, { maxBuffer: 200 * 1024 * 1024 });

            if (fs.existsSync(finalOutput) && fs.statSync(finalOutput).size > 0) {
                fs.unlinkSync(output);
                return finalOutput;
            }
        } catch (e) { console.log("FFmpeg boost failed, sending original."); }
        return output;

    } catch (e) {
        console.log("Download error:", e.message);
        return null;
    }
}

module.exports = { downloadMedia };
