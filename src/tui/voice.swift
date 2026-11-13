// pine's ears: turns what is said into text, on this Mac.
//
// The terminal UI starts this helper when its owner wants to dictate a message (src/tui/voice.ts
// builds it with swiftc on first use). It listens to the microphone, has the system recognise
// the words on the device, and writes what it hears as lines of JSON, one a line:
//
//   {"type":"ready"}                      listening
//   {"type":"partial","text":"..."}       everything heard so far; the end of it may still change
//   {"type":"final","text":"..."}         the whole of it; the helper ends after this line
//   {"type":"model","state":"downloading"} the system fetches its speech model for the language, once
//   {"type":"error","code":"...","message":"..."}   it cannot; the message says what to do
//
// It listens until its input is closed, which is how the UI says "that was all".
// `--check` only says what is there; `--file <audio>` reads a recording instead of the microphone.
//
// Nothing leaves the machine: on macOS 26 and later the system's own transcriber is used, which
// works on the device; before that the older recogniser, told to work on the device or not at all.
// The helper decides nothing and keeps nothing.

import AVFoundation
import Foundation
import Speech

func out(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return }
    print(s)
    fflush(stdout)
}

func fail(_ code: String, _ message: String) -> Never {
    out(["type": "error", "code": code, "message": message])
    exit(1)
}

// The system asks the app a program was started from whether it may listen, and shows that
// app's reasons. A terminal has none for speech. So the helper starts itself once more as a
// program of its own, which answers for itself with the reasons it carries (its Info.plist).
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

if ProcessInfo.processInfo.environment["PINE_VOICE_OWN"] == nil {
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
    _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
    setenv("PINE_VOICE_OWN", "1", 1)
    let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, path, nil, &attr, &argv, environ)
    fail("start", "the helper could not start as a program of its own (\(rc))")
}

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return nil
}

let wanted = arg("--locale").map { Locale(identifier: $0) } ?? Locale(identifier: Locale.current.identifier.components(separatedBy: "@")[0])
let file = arg("--file")
let authorization = ["notDetermined", "denied", "restricted", "authorized"]

/// Resolves when the UI has closed our input: the owner is done speaking.
func inputClosed() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().async {
            while true {
                let d = FileHandle.standardInput.availableData
                if d.isEmpty { break }
            }
            c.resume()
        }
    }
}

func microphone() async {
    if file != nil { return }
    let ok = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in AVCaptureDevice.requestAccess(for: .audio) { c.resume(returning: $0) } }
    if !ok { fail("microphone", "pine may not use the microphone. Allow it in System Settings > Privacy & Security > Microphone (the entry is called pine voice), then try again.") }
}

// ---- macOS 26 and later: the system's transcriber, which works on the device ------------------

@available(macOS 26.0, *)
func transcribe(_ locale: Locale) async throws {
    let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    var status = await AssetInventory.status(forModules: [transcriber])
    if status == .unsupported { fail("language", "this Mac has no speech recognition for \(locale.identifier).") }
    if status != .installed {
        out(["type": "model", "state": "downloading", "locale": locale.identifier])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
        status = await AssetInventory.status(forModules: [transcriber])
        if status != .installed { fail("model", "the system could not fetch its speech model for \(locale.identifier). It needs the network for that, once.") }
        out(["type": "model", "state": "installed", "locale": locale.identifier])
    }
    await microphone()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    // What is settled, and after it what is still being heard.
    let reader = Task { () -> String in
        var settled = ""
        for try await result in transcriber.results {
            let text = String(result.text.characters)
            if result.isFinal { settled += text }
            out(["type": "partial", "text": (result.isFinal ? settled : settled + text).trimmingCharacters(in: .whitespacesAndNewlines)])
        }
        return settled.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if let file = file {
        let audio = try AVAudioFile(forReading: URL(fileURLWithPath: file))
        out(["type": "ready"])
        if let end = try await analyzer.analyzeSequence(from: audio) { try await analyzer.finalizeAndFinish(through: end) } else { await analyzer.cancelAndFinishNow() }
    } else {
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { fail("audio", "the system named no sound format for speech recognition.") }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let from = input.outputFormat(forBus: 0)
        if from.sampleRate == 0 { fail("microphone", "this Mac has no microphone to listen with. Connect one, or choose one in System Settings > Sound > Input.") }
        guard let converter = AVAudioConverter(from: from, to: format) else { fail("audio", "the microphone's sound cannot be converted for speech recognition.") }
        let (stream, feed) = AsyncStream<AnalyzerInput>.makeStream()
        input.installTap(onBus: 0, bufferSize: 4096, format: from) { buffer, _ in
            let frames = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / from.sampleRate) + 64
            guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
            var given = false
            var problem: NSError?
            converter.convert(to: converted, error: &problem) { _, state in
                if given { state.pointee = .noDataNow; return nil }
                given = true
                state.pointee = .haveData
                return buffer
            }
            if problem == nil, converted.frameLength > 0 { feed.yield(AnalyzerInput(buffer: converted)) }
        }
        try await analyzer.start(inputSequence: stream)
        engine.prepare()
        try engine.start()
        out(["type": "ready"])
        await inputClosed()
        engine.stop()
        input.removeTap(onBus: 0)
        feed.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
    }
    out(["type": "final", "text": try await reader.value])
    exit(0)
}

// ---- before macOS 26: the older recogniser, on the device or not at all -----------------------

func transcribeClassic(_ locale: Locale) async {
    let granted = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
    if granted != .authorized { fail("permission", "pine may not use speech recognition (\(authorization[granted.rawValue])). Allow it in System Settings > Privacy & Security > Speech Recognition (the entry is called pine voice), then try again.") }
    guard let recognizer = SFSpeechRecognizer(locale: locale) else { fail("language", "this Mac has no speech recognition for \(locale.identifier).") }
    if !recognizer.supportsOnDeviceRecognition { fail("language", "this Mac cannot recognise \(locale.identifier) on the device. Add the language in System Settings > Keyboard > Dictation, then try again.") }
    await microphone()
    var last = ""
    let finish: (String?) -> Never = { problem in
        if let problem = problem, last.isEmpty {
            // What the system says when its own switch is off.
            if problem.contains("Dictation") { fail("dictation", "speech recognition is switched off on this Mac. Turn on Dictation in System Settings > Keyboard > Dictation, then try again.") }
            fail("recognition", problem)
        }
        out(["type": "final", "text": last])
        exit(0)
    }
    let handler: (SFSpeechRecognitionResult?, Error?) -> Void = { result, error in
        if let result = result {
            last = result.bestTranscription.formattedString
            if result.isFinal { finish(nil) }
            out(["type": "partial", "text": last])
        }
        if let error = error { finish(error.localizedDescription) }
    }
    if let file = file {
        let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: file))
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        out(["type": "ready"])
        _ = recognizer.recognitionTask(with: request, resultHandler: handler)
        return
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    if format.sampleRate == 0 { fail("microphone", "this Mac has no microphone to listen with. Connect one, or choose one in System Settings > Sound > Input.") }
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in request.append(buffer) }
    _ = recognizer.recognitionTask(with: request, resultHandler: handler)
    engine.prepare()
    do { try engine.start() } catch { fail("microphone", "the microphone could not be started (\(error.localizedDescription)).") }
    out(["type": "ready"])
    await inputClosed()
    engine.stop()
    input.removeTap(onBus: 0)
    request.endAudio()
    // The last words come a moment after the sound has ended.
    try? await Task.sleep(nanoseconds: 4_000_000_000)
    finish(nil)
}

Task {
    if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
        let supported = await SpeechTranscriber.supportedLocale(equivalentTo: wanted)
        if args.contains("--check") {
            let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
            let all = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
            out(["type": "status", "engine": "transcriber", "locale": supported?.identifier(.bcp47) ?? NSNull(), "wanted": wanted.identifier, "installed": installed.sorted(), "supported": all])
            exit(0)
        }
        guard let locale = supported else { fail("language", "this Mac has no speech recognition for \(wanted.identifier). Languages it knows: \((await SpeechTranscriber.supportedLocales).map { $0.identifier(.bcp47) }.sorted().joined(separator: ", ")).") }
        do { try await transcribe(locale) } catch { fail("recognition", error.localizedDescription) }
    } else {
        if args.contains("--check") {
            let r = SFSpeechRecognizer(locale: wanted)
            out(["type": "status", "engine": "classic", "locale": wanted.identifier, "permission": authorization[SFSpeechRecognizer.authorizationStatus().rawValue], "onDevice": r?.supportsOnDeviceRecognition ?? false])
            exit(0)
        }
        await transcribeClassic(wanted)
    }
}
dispatchMain()
