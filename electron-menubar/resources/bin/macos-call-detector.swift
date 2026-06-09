import CoreAudio
import Foundation

// macos-call-detector — meldet, WELCHE Prozesse gerade das Mikrofon nutzen (Core-Audio-
// Prozess-Properties, macOS >= 14). Vorbild: macos-globe-listener.swift / audiotee.
// Dient der Anruf-Erkennung: nutzt ein ANDERER Prozess als Paply das Mikro, läuft sehr
// wahrscheinlich ein Zwei-Wege-Anruf (Zoom/Teams/WhatsApp/FaceTime/Meet) auf diesem Mac.
//
// stdout = newline-getrennte JSON-Zeilen (wie audiotee):
//   {"message_type":"started"}
//   {"message_type":"input_state","data":{"bundles":["net.whatsapp.WhatsApp"]}}  (nur bei Änderung)
//   {"message_type":"error","data":{"message":"..."}}
// Die FILTER-Entscheidung (Paply ausschließen, Anruf ja/nein) trifft die Node-Seite
// (CallDetectorManager) — testbar in JS. Dieser Helfer liefert nur die rohe Tatsache.
//
// Flags: --interval <sekunden> (Standard 1.0)
// Liest nur Prozess-Properties — KEINE TCC-Berechtigung nötig (kein Tap, keine Aufnahme).

setbuf(stdout, nil)

var interval = 1.0
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--interval", i + 1 < args.count { interval = Double(args[i + 1]) ?? 1.0; i += 2 }
    else { i += 1 }
}

func emit(_ type: String, _ data: [String: Any]? = nil) {
    var obj: [String: Any] = ["message_type": type]
    if let d = data { obj["data"] = d }
    if let json = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: json, encoding: .utf8) {
        print(s)
    }
}

func processList() -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func isRunningInput(_ obj: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyIsRunningInput, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var val: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &val) == noErr && val != 0
}

func bundleID(_ obj: AudioObjectID) -> String {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return "" }
    var cf: CFString = "" as CFString
    let st = withUnsafeMutablePointer(to: &cf) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0) }
    return st == noErr ? (cf as String) : ""
}

func currentInputBundles() -> [String] {
    var set = Set<String>()
    for obj in processList() where isRunningInput(obj) {
        let b = bundleID(obj)
        if !b.isEmpty { set.insert(b) }
    }
    return set.sorted()
}

emit("started")
var last: [String] = ["__init__"] // erzwingt erste Emission
while true {
    let now = currentInputBundles()
    if now != last {
        last = now
        emit("input_state", ["bundles": now])
    }
    Thread.sleep(forTimeInterval: interval)
}
