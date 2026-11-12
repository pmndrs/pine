// The helper of pine's bundled MCP server "computer" (mcp/computer.ts), for macOS.
//
// It is the only native code in pine, and it is small on purpose: it does what Node cannot do
// (read an app's accessibility tree, press its controls, post mouse and key events, take a
// picture of a window) and decides nothing. Which app may be operated, what a result says and how
// a picture's coordinates become a point on the screen is all in computer.ts, where it is tested.
//
// pine compiles this file with `swiftc` the first time app control is used and keeps the program
// in its home. It speaks JSON lines: one request per line on stdin ({"id", "cmd", ...}), one
// answer per line on stdout ({"id", "ok", ...} or {"id", "ok": false, "code", "error"}).
//
// Points are global screen points: the origin is the top left corner of the main display, y
// grows downwards, and a second display continues the same plane. The accessibility API, mouse
// events and window bounds all use them.
//
// Started with --demo it opens a small window of its own ("Pine Demo"). A process may read its
// own accessibility tree without the owner's grant, so the live tests can drive the real code
// against that window on a machine where nothing was granted.
import AppKit
import ApplicationServices
import Carbon.HIToolbox

struct Fail: Error {
	let code: String
	let message: String
}

func send(_ obj: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/** Waits without stopping the run loop: what AppKit knows about other apps arrives through it. */
func wait(_ seconds: Double) {
	RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

// ---- references ----------------------------------------------------------------------------------

/** An accessibility element as a dictionary key: the same control gets the same reference every time. */
final class Key: Hashable {
	let el: AXUIElement
	init(_ el: AXUIElement) { self.el = el }
	static func == (a: Key, b: Key) -> Bool { return CFEqual(a.el, b.el) }
	func hash(into h: inout Hasher) { h.combine(CFHash(el)) }
}

var elements: [String: AXUIElement] = [:]
var names: [Key: String] = [:]
var counter = 0

func refFor(_ el: AXUIElement) -> String {
	let k = Key(el)
	if let r = names[k] { return r }
	// Controls that are gone are forgotten all at once, rarely: a reference that was dropped is answered with "gone".
	if elements.count > 50_000 {
		elements.removeAll()
		names.removeAll()
	}
	counter += 1
	let r = "e\(counter)"
	names[k] = r
	elements[r] = el
	return r
}

func element(_ p: [String: Any]) throws -> AXUIElement {
	guard let r = p["ref"] as? String, let el = elements[r] else { throw Fail(code: "gone", message: "no control has this reference") }
	return el
}

// ---- accessibility -------------------------------------------------------------------------------

func isMissing(_ v: AnyObject) -> Bool {
	if v is NSNull { return true }
	if CFGetTypeID(v) == AXValueGetTypeID() { return AXValueGetType(v as! AXValue) == .axError }
	return false
}

func copy(_ el: AXUIElement, _ name: String) -> AnyObject? {
	var v: CFTypeRef?
	guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let got = v, !isMissing(got) else { return nil }
	return got
}

func many(_ el: AXUIElement, _ attrs: [String]) -> [AnyObject?]? {
	var raw: CFArray?
	guard AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success, let vals = raw as? [AnyObject], vals.count == attrs.count else { return nil }
	return vals.map { isMissing($0) ? nil : $0 }
}

func check(_ e: AXError, _ what: String) throws {
	switch e {
	case .success: return
	case .apiDisabled: throw Fail(code: "accessibility", message: "")
	case .invalidUIElement: throw Fail(code: "gone", message: "this control does not exist any more")
	case .cannotComplete: throw Fail(code: "failed", message: "\(what): the app did not answer")
	default: throw Fail(code: "failed", message: "\(what) did not work (accessibility error \(e.rawValue))")
	}
}

func point(_ v: AnyObject?) -> CGPoint? {
	guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
	var p = CGPoint.zero
	return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ v: AnyObject?) -> CGSize? {
	guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
	var s = CGSize.zero
	return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func frame(_ el: AXUIElement) -> CGRect? {
	guard let p = point(copy(el, "AXPosition")), let s = size(copy(el, "AXSize")) else { return nil }
	return CGRect(origin: p, size: s)
}

func actions(_ el: AXUIElement) -> [String] {
	var raw: CFArray?
	guard AXUIElementCopyActionNames(el, &raw) == .success else { return [] }
	return (raw as? [String]) ?? []
}

func settable(_ el: AXUIElement, _ attr: String) -> Bool {
	var yes: DarwinBoolean = false
	return AXUIElementIsAttributeSettable(el, attr as CFString, &yes) == .success && yes.boolValue
}

/** Reading another app needs the owner's grant. A process may always read itself (the demo window). */
func needAccess(_ pid: pid_t) throws {
	if pid != getpid() && !AXIsProcessTrusted() { throw Fail(code: "accessibility", message: "") }
}

/** Mouse and key events go nowhere without the grant, and say nothing about it. */
func needInput() throws {
	if !AXIsProcessTrusted() { throw Fail(code: "accessibility", message: "") }
}

// ---- apps ----------------------------------------------------------------------------------------

func parentOf(_ pid: pid_t) -> pid_t {
	var info = kinfo_proc()
	var length = MemoryLayout<kinfo_proc>.stride
	var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
	guard sysctl(&mib, 4, &info, &length, nil, 0) == 0, length > 0 else { return 0 }
	return info.kp_eproc.e_ppid
}

/** The app pine itself runs in: the first app with windows among the processes that started this one. */
let hostApp: NSRunningApplication? = {
	var pid = getppid()
	for _ in 0..<32 {
		if pid <= 1 { break }
		if let a = NSRunningApplication(processIdentifier: pid), a.activationPolicy == .regular { return a }
		pid = parentOf(pid)
	}
	return nil
}()

let demoName = "Pine Demo"
var demo: Demo?

func nameOf(_ a: NSRunningApplication) -> String {
	if demo != nil && a.processIdentifier == getpid() { return demoName }
	return a.localizedName ?? a.executableURL?.lastPathComponent ?? "pid \(a.processIdentifier)"
}

func info(_ a: NSRunningApplication) -> [String: Any] {
	return [
		"name": nameOf(a),
		"pid": Int(a.processIdentifier),
		"bundle": a.bundleIdentifier ?? "",
		"host": hostApp != nil && a.processIdentifier == hostApp!.processIdentifier,
		"front": NSWorkspace.shared.frontmostApplication?.processIdentifier == a.processIdentifier,
		"hidden": a.isHidden,
	]
}

/** The running app somebody means by a name: its name, its bundle id, or the name of its file. */
func lookUp(_ query: String) -> NSRunningApplication? {
	let q = query.trimmingCharacters(in: .whitespaces).lowercased()
	if q.isEmpty { return nil }
	if demo != nil && q == demoName.lowercased() { return NSRunningApplication.current }
	let all = NSWorkspace.shared.runningApplications
	// An app with windows before a background one of the same name.
	let ordered = all.filter { $0.activationPolicy == .regular } + all.filter { $0.activationPolicy != .regular }
	let tests: [(NSRunningApplication) -> String?] = [
		{ $0.localizedName },
		{ $0.bundleIdentifier },
		{ $0.bundleURL?.deletingPathExtension().lastPathComponent },
		{ $0.executableURL?.lastPathComponent },
	]
	for test in tests {
		if let a = ordered.first(where: { test($0)?.lowercased() == q }) { return a }
	}
	return nil
}

func running(_ p: [String: Any]) throws -> NSRunningApplication {
	guard let n = p["pid"] as? Int, let a = NSRunningApplication(processIdentifier: pid_t(n)), !a.isTerminated else { throw Fail(code: "not_running", message: "the app is not running any more") }
	return a
}

func appElement(_ pid: pid_t) -> AXUIElement {
	let el = AXUIElementCreateApplication(pid)
	// An app that hangs must not hang pine with it.
	AXUIElementSetMessagingTimeout(el, 3)
	return el
}

func windowsOf(_ app: AXUIElement) -> [AXUIElement] {
	return (copy(app, "AXWindows") as? [AXUIElement]) ?? []
}

func describe(_ w: AXUIElement, index: Int) -> [String: Any] {
	var d: [String: Any] = ["index": index, "ref": refFor(w), "title": (copy(w, "AXTitle") as? String) ?? ""]
	if (copy(w, "AXMinimized") as? Bool) == true { d["minimized"] = true }
	if (copy(w, "AXMain") as? Bool) == true { d["main"] = true }
	if let f = frame(w) {
		d["x"] = Int(f.minX)
		d["y"] = Int(f.minY)
		d["w"] = Int(f.width)
		d["h"] = Int(f.height)
	}
	return d
}

func windowList(_ pid: pid_t) -> [[String: Any]] {
	return windowsOf(appElement(pid)).enumerated().map { describe($0.element, index: $0.offset + 1) }
}

// ---- the outline ---------------------------------------------------------------------------------

let ATTRS = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFocused", "AXSelected", "AXPosition", "AXSize", "AXChildren", "AXHelp", "AXPlaceholderValue", "AXVisibleRows"]
/** Not worth a line in an outline, with everything inside. */
let SKIPPED: Set<String> = ["AXScrollBar", "AXGrowArea", "AXSplitter", "AXColumn", "AXRuler", "AXMenuBar"]
/** Containers: asking them what can be done with them is a wasted question. */
let PASSIVE: Set<String> = ["AXWindow", "AXScrollArea", "AXSplitGroup", "AXTable", "AXOutline", "AXList", "AXToolbar", "AXTabGroup", "AXLayoutArea", "AXStaticText", "AXSheet", "AXWebArea"]
let PRESS = ["AXPress", "AXPick", "AXOpen", "AXConfirm"]
let EDITABLE: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXIncrementor"]

struct Walk {
	var count = 0
	var cut = false
	let limit: Int
}

func node(_ el: AXUIElement, depth: Int, walk: inout Walk) -> [String: Any]? {
	if walk.count >= walk.limit || depth > 60 {
		walk.cut = true
		return nil
	}
	guard let v = many(el, ATTRS), let role = v[0] as? String, !SKIPPED.contains(role) else { return nil }
	walk.count += 1
	var n: [String: Any] = ["role": role]
	if let s = v[1] as? String, !s.isEmpty { n["subrole"] = s }
	if let s = v[2] as? String, !s.isEmpty { n["title"] = s }
	if let s = v[3] as? String, !s.isEmpty { n["desc"] = s }
	if let s = v[4] as? String {
		if !s.isEmpty { n["value"] = s.count > 6000 ? String(s.prefix(6000)) : s }
		if s.count > 6000 { n["more"] = s.count - 6000 }
	} else if let num = v[4] as? NSNumber {
		n["value"] = num
	}
	if (v[5] as? Bool) == false { n["disabled"] = true }
	if (v[6] as? Bool) == true { n["focused"] = true }
	if (v[7] as? Bool) == true { n["selected"] = true }
	if let s = v[11] as? String, !s.isEmpty { n["help"] = s }
	if let s = v[12] as? String, !s.isEmpty { n["placeholder"] = s }
	let press = PASSIVE.contains(role) ? false : actions(el).contains(where: { PRESS.contains($0) })
	let edit = EDITABLE.contains(role) && settable(el, "AXValue")
	if press { n["press"] = true }
	if edit { n["edit"] = true }
	// A reference for what can be acted on: pressed, written into, or (a row) selected.
	if press || edit || role == "AXRow" || EDITABLE.contains(role) { n["ref"] = refFor(el) }
	// A long table is its visible rows: the rest is reached by scrolling.
	let kids = (v[13] as? [AXUIElement]) ?? (v[10] as? [AXUIElement]) ?? []
	var children: [[String: Any]] = []
	for kid in kids {
		if let c = node(kid, depth: depth + 1, walk: &walk) { children.append(c) }
	}
	if !children.isEmpty { n["children"] = children }
	return n
}

// ---- input ---------------------------------------------------------------------------------------

let source = CGEventSource(stateID: .hidSystemState)

func mouse(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
	guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { return }
	e.setIntegerValueField(.mouseEventClickState, value: clicks)
	e.post(tap: .cghidEventTap)
}

let NAMED_KEYS: [String: Int] = [
	"return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "delete": kVK_Delete, "backspace": kVK_Delete,
	"forwarddelete": kVK_ForwardDelete, "escape": kVK_Escape, "esc": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow,
	"down": kVK_DownArrow, "up": kVK_UpArrow, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
	"f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
]
/** Where the characters are on an American keyboard: used when the layout in use cannot be read. */
let ANSI_KEYS: [String: Int] = [
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
	"1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
	"i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]

/**
 * Which key makes which character on the keyboard layout in use. A shortcut is pressed by key,
 * and on a German keyboard the key for "z" is where an American one has "y".
 */
func layoutKeys() -> [String: (Int, Bool)] {
	var map: [String: (Int, Bool)] = [:]
	for candidate in [TISCopyCurrentKeyboardLayoutInputSource(), TISCopyCurrentASCIICapableKeyboardLayoutInputSource()] {
		guard let src = candidate?.takeRetainedValue(), let raw = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { continue }
		let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
		data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
			guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
			for shift in [false, true] {
				for code in 0..<128 {
					var dead: UInt32 = 0
					var chars = [UniChar](repeating: 0, count: 4)
					var length = 0
					let mods: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xFF) : 0
					let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), mods, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, 4, &length, &chars)
					if status == noErr && length == 1 && chars[0] > 32 {
						let s = String(utf16CodeUnits: chars, count: 1)
						if map[s] == nil { map[s] = (code, shift) }
					}
				}
			}
		}
	}
	return map
}

func flags(_ mods: [String]) -> CGEventFlags {
	var f = CGEventFlags()
	for m in mods {
		switch m {
		case "cmd": f.insert(.maskCommand)
		case "shift": f.insert(.maskShift)
		case "alt": f.insert(.maskAlternate)
		case "ctrl": f.insert(.maskControl)
		case "fn": f.insert(.maskSecondaryFn)
		default: break
		}
	}
	return f
}

/**
 * Key events go to the app they are meant for, not to whatever is in front: an owner who clicks
 * into another window while an agent types does not get the rest of the text typed into it.
 */
func post(_ e: CGEvent, to pid: pid_t) {
	if pid > 0 { e.postToPid(pid) } else { e.post(tap: .cghidEventTap) }
}

func pressKey(_ code: Int, _ f: CGEventFlags, to pid: pid_t) {
	for down in [true, false] {
		guard let e = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down) else { continue }
		e.flags = f
		post(e, to: pid)
		usleep(10_000)
	}
}

func typeText(_ text: String, to pid: pid_t) {
	// A line break is the return key and a tab the tab key: as text they are not always taken for that.
	var run: [UniChar] = []
	func flush() {
		var i = 0
		while i < run.count {
			let part = Array(run[i..<min(i + 16, run.count)])
			for down in [true, false] {
				guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
				part.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: part.count, unicodeString: $0.baseAddress) }
				// Without this the event carries the modifier keys the owner happens to hold.
				e.flags = []
				post(e, to: pid)
				usleep(10_000)
			}
			i += 16
		}
		run = []
	}
	for unit in text.replacingOccurrences(of: "\r\n", with: "\n").utf16 {
		if unit == 10 || unit == 13 {
			flush()
			pressKey(kVK_Return, [], to: pid)
		} else if unit == 9 {
			flush()
			pressKey(kVK_Tab, [], to: pid)
		} else {
			run.append(unit)
		}
	}
	flush()
}

// ---- pictures ------------------------------------------------------------------------------------

func runTool(_ path: String, _ args: [String]) -> (Int32, String) {
	let p = Process()
	p.executableURL = URL(fileURLWithPath: path)
	p.arguments = args
	let err = Pipe()
	p.standardError = err
	p.standardOutput = FileHandle.nullDevice
	do { try p.run() } catch { return (-1, "\(error.localizedDescription)") }
	let data = err.fileHandleForReading.readDataToEndOfFile()
	p.waitUntilExit()
	return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

/** The window server's number for a window of an app, found by where the window is. */
func windowNumber(pid: pid_t, at f: CGRect) -> Int? {
	guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
	for w in list {
		guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid, (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { continue }
		guard let b = w[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: b), let id = (w[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
		if abs(rect.minX - f.minX) < 3 && abs(rect.minY - f.minY) < 3 && abs(rect.width - f.width) < 3 && abs(rect.height - f.height) < 3 { return id }
	}
	return nil
}

/** Whose window is on top at a point, among ordinary windows. */
func windowOwner(at p: CGPoint) -> pid_t? {
	guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
	for w in list {
		guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0, ((w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0 else { continue }
		guard let b = w[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: b), rect.contains(p) else { continue }
		return (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
	}
	return nil
}

func displays() -> [[String: Any]] {
	var ids = [CGDirectDisplayID](repeating: 0, count: 16)
	var count: UInt32 = 0
	guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return [] }
	return (0..<Int(count)).map { i in
		let b = CGDisplayBounds(ids[i])
		return ["index": i + 1, "x": Int(b.minX), "y": Int(b.minY), "w": Int(b.width), "h": Int(b.height), "main": CGDisplayIsMain(ids[i]) != 0]
	}
}

/** Writes a picture no larger than asked for, as JPEG: a model is sent every picture again with every turn. */
func shrink(_ from: URL, to: URL, edge: Double, area: Double) throws -> (Int, Int) {
	guard let src = CGImageSourceCreateWithURL(from as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw Fail(code: "failed", message: "the picture could not be read") }
	let W = Double(image.width)
	let H = Double(image.height)
	let scale = min(1, edge / max(W, H), (area / (W * H)).squareRoot())
	let w = max(1, Int((W * scale).rounded()))
	let h = max(1, Int((H * scale).rounded()))
	guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw Fail(code: "failed", message: "the picture could not be made smaller") }
	ctx.setFillColor(CGColor(gray: 1, alpha: 1))
	ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
	ctx.interpolationQuality = .high
	ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
	guard let small = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(to as CFURL, "public.jpeg" as CFString, 1, nil) else { throw Fail(code: "failed", message: "the picture could not be written") }
	CGImageDestinationAddImage(dest, small, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
	guard CGImageDestinationFinalize(dest) else { throw Fail(code: "failed", message: "the picture could not be written") }
	return (w, h)
}

// ---- the demo window -----------------------------------------------------------------------------

final class Demo: NSObject {
	let window = NSWindow(contentRect: NSRect(x: 240, y: 320, width: 360, height: 190), styleMask: [.titled, .closable], backing: .buffered, defer: false)
	let field = NSTextField(frame: NSRect(x: 20, y: 130, width: 320, height: 24))
	let result = NSTextField(labelWithString: "Nothing yet")
	let loud = NSButton(checkboxWithTitle: "Loud", target: nil, action: nil)

	func open() {
		NSApp.setActivationPolicy(.accessory)
		window.title = demoName
		window.isReleasedWhenClosed = false
		field.placeholderString = "A word"
		let button = NSButton(title: "Shout", target: self, action: #selector(shout(_:)))
		button.frame = NSRect(x: 20, y: 80, width: 100, height: 32)
		loud.frame = NSRect(x: 140, y: 84, width: 120, height: 24)
		result.frame = NSRect(x: 20, y: 30, width: 320, height: 24)
		for view in [field, button, loud, result] as [NSView] { window.contentView?.addSubview(view) }
		let bar = NSMenu()
		let item = NSMenuItem(title: "Demo", action: nil, keyEquivalent: "")
		let menu = NSMenu(title: "Demo")
		let reset = NSMenuItem(title: "Reset", action: #selector(reset(_:)), keyEquivalent: "r")
		reset.target = self
		menu.addItem(reset)
		item.submenu = menu
		bar.addItem(NSMenuItem(title: "Apple", action: nil, keyEquivalent: ""))
		bar.addItem(item)
		NSApp.mainMenu = bar
		window.orderFrontRegardless()
	}

	@objc func shout(_ sender: Any?) {
		result.stringValue = field.stringValue.uppercased() + (loud.state == .on ? "!!!" : "!")
	}

	@objc func reset(_ sender: Any?) {
		field.stringValue = ""
		result.stringValue = "Nothing yet"
	}
}

// ---- commands ------------------------------------------------------------------------------------

func num(_ p: [String: Any], _ key: String) throws -> Double {
	guard let n = p[key] as? NSNumber else { throw Fail(code: "failed", message: "\(key) is missing") }
	return n.doubleValue
}

func handle(_ cmd: String, _ p: [String: Any]) throws -> [String: Any] {
	switch cmd {
	case "status":
		// Asking makes macOS show its own window, which leads the owner to the right switch.
		if (p["ask"] as? String) == "accessibility" { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
		if (p["ask"] as? String) == "screen" { _ = CGRequestScreenCaptureAccess() }
		var r: [String: Any] = ["accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess(), "pid": Int(getpid())]
		if let h = hostApp { r["host"] = info(h) }
		return r

	case "apps":
		let trusted = AXIsProcessTrusted()
		var list: [[String: Any]] = []
		var apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
		if demo != nil { apps.append(NSRunningApplication.current) }
		for a in apps {
			var d = info(a)
			if trusted || a.processIdentifier == getpid() {
				let el = AXUIElementCreateApplication(a.processIdentifier)
				AXUIElementSetMessagingTimeout(el, 1)
				d["windows"] = windowsOf(el).enumerated().map { describe($0.element, index: $0.offset + 1) }
			}
			list.append(d)
		}
		return ["apps": list, "displays": displays(), "accessibility": trusted]

	case "find":
		guard let query = p["app"] as? String, let a = lookUp(query) else { return ["running": false] }
		var d = info(a)
		d["running"] = true
		return d

	case "open":
		guard let query = p["app"] as? String, !query.isEmpty else { throw Fail(code: "failed", message: "app is missing") }
		if let a = lookUp(query) {
			var d = info(a)
			d["launched"] = false
			return d
		}
		var (status, err) = runTool("/usr/bin/open", ["-a", query])
		if status != 0 && query.range(of: "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$", options: .regularExpression) != nil { (status, err) = runTool("/usr/bin/open", ["-b", query]) }
		if status != 0 { throw Fail(code: "not_found", message: err.trimmingCharacters(in: .whitespacesAndNewlines)) }
		for _ in 0..<150 {
			if let a = lookUp(query), a.isFinishedLaunching {
				var d = info(a)
				d["launched"] = true
				return d
			}
			wait(0.1)
		}
		throw Fail(code: "failed", message: "the app was started but did not appear")

	case "activate":
		let a = try running(p)
		let pid = a.processIdentifier
		if pid == getpid() {
			demo?.window.orderFrontRegardless()
			return ["front": true]
		}
		let wasFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
		if a.isHidden { a.unhide() }
		let el = appElement(pid)
		// Bringing an app forward works without the owner's grant; its windows are only reached with it.
		let trusted = AXIsProcessTrusted()
		if trusted {
			let all = windowsOf(el)
			// Windows that were all put away into the Dock: the first one comes back.
			if !all.isEmpty && all.allSatisfy({ (copy($0, "AXMinimized") as? Bool) == true }) { AXUIElementSetAttributeValue(all[0], "AXMinimized" as CFString, kCFBooleanFalse) }
			if p["ref"] != nil, let w = try? element(p) {
				if (copy(w, "AXMinimized") as? Bool) == true { AXUIElementSetAttributeValue(w, "AXMinimized" as CFString, kCFBooleanFalse) }
				AXUIElementPerformAction(w, "AXRaise" as CFString)
				AXUIElementSetAttributeValue(w, "AXMain" as CFString, kCFBooleanTrue)
			}
		}
		// 3: all windows, and in front of the app that is active now.
		a.activate(options: NSApplication.ActivationOptions(rawValue: 3))
		if trusted { AXUIElementSetAttributeValue(el, "AXFrontmost" as CFString, kCFBooleanTrue) }
		for _ in 0..<30 {
			if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
				// An app that has just come forward drops the keys and clicks of its first moment.
				if !wasFront { wait(0.35) }
				return ["front": true]
			}
			wait(0.05)
		}
		return ["front": trusted && (copy(el, "AXFrontmost") as? Bool) == true]

	case "windows":
		let a = try running(p)
		try needAccess(a.processIdentifier)
		return ["windows": windowList(a.processIdentifier)]

	case "frame":
		let el = try element(p)
		guard let f = frame(el) else { throw Fail(code: "gone", message: "this window does not exist any more") }
		return ["x": Double(f.minX), "y": Double(f.minY), "w": Double(f.width), "h": Double(f.height)]

	case "tree":
		let a = try running(p)
		let pid = a.processIdentifier
		try needAccess(pid)
		let el = appElement(pid)
		// Apps built on a browser (Electron) only describe their windows to somebody who asks for it.
		if pid != getpid() { AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue) }
		let all = windowsOf(el)
		var r: [String: Any] = ["windows": all.enumerated().map { describe($0.element, index: $0.offset + 1) }]
		var chosen: AXUIElement?
		if let n = p["window"] as? Int {
			guard n >= 1 && n <= all.count else { throw Fail(code: "not_found", message: "there is no window \(n)") }
			chosen = all[n - 1]
		} else if let w = copy(el, "AXFocusedWindow"), CFGetTypeID(w) == AXUIElementGetTypeID() {
			chosen = (w as! AXUIElement)
		} else if let w = copy(el, "AXMainWindow"), CFGetTypeID(w) == AXUIElementGetTypeID() {
			chosen = (w as! AXUIElement)
		} else {
			chosen = all.first
		}
		guard let w = chosen else { return r }
		var walk = Walk(limit: (p["max"] as? Int) ?? 2500)
		let index = (all.firstIndex(where: { CFEqual($0, w) }) ?? 0) + 1
		r["window"] = describe(w, index: index)
		if let root = node(w, depth: 0, walk: &walk) { r["root"] = root }
		r["cut"] = walk.cut
		return r

	case "menu":
		let a = try running(p)
		try needAccess(a.processIdentifier)
		var parent: AXUIElement
		if p["ref"] != nil {
			parent = try element(p)
		} else {
			guard let bar = copy(appElement(a.processIdentifier), "AXMenuBar"), CFGetTypeID(bar) == AXUIElementGetTypeID() else { return ["items": [[String: Any]]()] }
			parent = bar as! AXUIElement
		}
		var kids = (copy(parent, "AXChildren") as? [AXUIElement]) ?? []
		// An entry holds its menu, and the menu holds the entries.
		if kids.count == 1, (copy(kids[0], "AXRole") as? String) == "AXMenu" {
			parent = kids[0]
			kids = (copy(parent, "AXChildren") as? [AXUIElement]) ?? []
		}
		var items: [[String: Any]] = []
		for kid in kids {
			guard let v = many(kid, ["AXTitle", "AXEnabled", "AXMenuItemMarkChar", "AXMenuItemCmdChar", "AXMenuItemCmdModifiers", "AXChildren"]) else { continue }
			guard let title = v[0] as? String, !title.isEmpty else { continue }
			var d: [String: Any] = ["ref": refFor(kid), "title": title]
			if (v[1] as? Bool) == false { d["disabled"] = true }
			if let mark = v[2] as? String, !mark.isEmpty { d["mark"] = mark }
			if let ch = v[3] as? String, !ch.isEmpty {
				let m = (v[4] as? NSNumber)?.intValue ?? 0
				d["shortcut"] = (m & 4 != 0 ? "ctrl+" : "") + (m & 2 != 0 ? "alt+" : "") + (m & 1 != 0 ? "shift+" : "") + (m & 8 == 0 ? "cmd+" : "") + ch.lowercased()
			}
			if let sub = v[5] as? [AXUIElement], !sub.isEmpty { d["submenu"] = true }
			items.append(d)
		}
		return ["items": items]

	case "whose":
		let el = try element(p)
		var pid: pid_t = 0
		try check(AXUIElementGetPid(el, &pid), "finding the control")
		guard let v = many(el, ["AXRole", "AXSubrole", "AXTitle", "AXDescription"]), let role = v[0] as? String else { throw Fail(code: "gone", message: "this control does not exist any more") }
		var d: [String: Any] = ["pid": Int(pid), "role": role]
		if let s = v[1] as? String, !s.isEmpty { d["subrole"] = s }
		if let s = (v[2] as? String) ?? (v[3] as? String), !s.isEmpty { d["title"] = s }
		return d

	case "press":
		let el = try element(p)
		let has = actions(el)
		for name in PRESS where has.contains(name) {
			let e = AXUIElementPerformAction(el, name as CFString)
			// A press that opens a dialog is often not answered until the dialog is closed.
			if e == .cannotComplete { return ["done": true, "unsure": true] }
			try check(e, "pressing")
			return ["done": true]
		}
		if settable(el, "AXSelected") {
			try check(AXUIElementSetAttributeValue(el, "AXSelected" as CFString, kCFBooleanTrue), "selecting")
			return ["done": true, "selected": true]
		}
		// Nothing to press by name: the caller clicks in its middle instead.
		guard let f = frame(el), f.width > 0, f.height > 0 else { throw Fail(code: "failed", message: "this control cannot be pressed") }
		return ["done": false, "x": Double(f.midX), "y": Double(f.midY)]

	case "set":
		let el = try element(p)
		guard let text = p["text"] as? String else { throw Fail(code: "failed", message: "text is missing") }
		AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
		if settable(el, "AXValue") {
			// A slider takes a number, everything else text.
			let value: AnyObject = (copy(el, "AXValue") is NSNumber && Double(text) != nil) ? NSNumber(value: Double(text)!) : text as NSString
			try check(AXUIElementSetAttributeValue(el, "AXValue" as CFString, value), "writing")
			return ["done": true]
		}
		guard let f = frame(el), f.width > 0, f.height > 0 else { throw Fail(code: "failed", message: "this control takes no text") }
		return ["done": false, "x": Double(f.midX), "y": Double(f.midY)]

	case "at":
		try needInput()
		let x = try num(p, "x")
		let y = try num(p, "y")
		var r: [String: Any] = [:]
		var hit: AXUIElement?
		if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success, let el = hit {
			var pid: pid_t = 0
			if AXUIElementGetPid(el, &pid) == .success {
				r["pid"] = Int(pid)
				if let a = NSRunningApplication(processIdentifier: pid) { r["name"] = nameOf(a) }
			}
			if let v = many(el, ["AXRole", "AXSubrole", "AXTitle", "AXDescription"]), let role = v[0] as? String {
				r["role"] = role
				if let s = v[1] as? String, !s.isEmpty { r["subrole"] = s }
				if let s = (v[2] as? String) ?? (v[3] as? String), !s.isEmpty { r["title"] = s }
			}
		}
		if let owner = windowOwner(at: CGPoint(x: x, y: y)) {
			r["wpid"] = Int(owner)
			if let a = NSRunningApplication(processIdentifier: owner) { r["wname"] = nameOf(a) }
		}
		return r

	case "click":
		try needInput()
		let at = CGPoint(x: try num(p, "x"), y: try num(p, "y"))
		let right = (p["button"] as? String) == "right"
		let count = max(1, min(3, (p["count"] as? Int) ?? 1))
		mouse(.mouseMoved, at)
		usleep(30_000)
		for i in 1...count {
			mouse(right ? .rightMouseDown : .leftMouseDown, at, right ? .right : .left, clicks: Int64(i))
			usleep(20_000)
			mouse(right ? .rightMouseUp : .leftMouseUp, at, right ? .right : .left, clicks: Int64(i))
			usleep(40_000)
		}
		return [:]

	case "drag":
		try needInput()
		let from = CGPoint(x: try num(p, "x"), y: try num(p, "y"))
		let to = CGPoint(x: try num(p, "x2"), y: try num(p, "y2"))
		mouse(.mouseMoved, from)
		usleep(30_000)
		mouse(.leftMouseDown, from)
		usleep(80_000)
		// In steps: an app only takes a drag for one when the pointer travels.
		for i in 1...12 {
			let t = CGFloat(i) / 12
			mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
			usleep(15_000)
		}
		usleep(60_000)
		mouse(.leftMouseUp, to)
		return [:]

	case "scroll":
		try needInput()
		let at = CGPoint(x: try num(p, "x"), y: try num(p, "y"))
		var dx = Int32((p["dx"] as? Int) ?? 0)
		var dy = Int32((p["dy"] as? Int) ?? 0)
		mouse(.mouseMoved, at)
		usleep(30_000)
		// A few lines at a time, as a wheel does.
		while dx != 0 || dy != 0 {
			let sx = max(-3, min(3, dx))
			let sy = max(-3, min(3, dy))
			if let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: sy, wheel2: sx, wheel3: 0) { e.post(tap: .cghidEventTap) }
			dx -= sx
			dy -= sy
			usleep(15_000)
		}
		return [:]

	case "type":
		try needInput()
		guard let text = p["text"] as? String else { throw Fail(code: "failed", message: "text is missing") }
		typeText(text, to: pid_t((p["pid"] as? Int) ?? 0))
		return [:]

	case "key":
		try needInput()
		guard let key = (p["key"] as? String)?.lowercased(), !key.isEmpty else { throw Fail(code: "failed", message: "key is missing") }
		var f = flags((p["mods"] as? [String]) ?? [])
		let to = pid_t((p["pid"] as? Int) ?? 0)
		if let code = NAMED_KEYS[key] {
			pressKey(code, f, to: to)
		} else if let (code, shift) = layoutKeys()[key] {
			if shift { f.insert(.maskShift) }
			pressKey(code, f, to: to)
		} else if let code = ANSI_KEYS[key] {
			pressKey(code, f, to: to)
		} else {
			throw Fail(code: "unknown_key", message: "there is no key \"\(key)\" on this keyboard")
		}
		return [:]

	case "shot":
		if !CGPreflightScreenCaptureAccess() { throw Fail(code: "screen", message: "") }
		guard let dir = p["dir"] as? String else { throw Fail(code: "failed", message: "dir is missing") }
		let name = "shot-\(getpid())-\(Int(Date().timeIntervalSince1970 * 1000))"
		let raw = URL(fileURLWithPath: dir).appendingPathComponent(name + ".png")
		let small = URL(fileURLWithPath: dir).appendingPathComponent(name + ".jpg")
		defer { try? FileManager.default.removeItem(at: raw) }
		var args = ["-x", "-t", "png"]
		var area: CGRect
		var r: [String: Any] = [:]
		if p["ref"] != nil {
			let w = try element(p)
			guard let f = frame(w), f.width > 1, f.height > 1 else { throw Fail(code: "gone", message: "this window does not exist any more") }
			if (copy(w, "AXMinimized") as? Bool) == true { throw Fail(code: "minimized", message: "") }
			var pid: pid_t = 0
			AXUIElementGetPid(w, &pid)
			area = f
			// The window itself, also where another one covers it. Without its number: what is on the screen in its place.
			if let id = windowNumber(pid: pid, at: f) { args += ["-o", "-l", String(id)] } else { args += ["-R", "\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width)),\(Int(f.height))"] }
		} else {
			let all = displays()
			let n = (p["display"] as? Int) ?? 1
			guard n >= 1 && n <= all.count else { throw Fail(code: "not_found", message: "there is no screen \(n); there \(all.count == 1 ? "is 1 screen" : "are \(all.count) screens")") }
			let d = all[n - 1]
			area = CGRect(x: d["x"] as! Int, y: d["y"] as! Int, width: d["w"] as! Int, height: d["h"] as! Int)
			args += ["-R", "\(Int(area.minX)),\(Int(area.minY)),\(Int(area.width)),\(Int(area.height))"]
			r["display"] = n
			r["displays"] = all.count
		}
		let (status, err) = runTool("/usr/sbin/screencapture", args + [raw.path])
		guard status == 0, FileManager.default.fileExists(atPath: raw.path) else { throw Fail(code: "failed", message: "the picture could not be taken\(err.isEmpty ? "" : ": " + err.trimmingCharacters(in: .whitespacesAndNewlines))") }
		let (w, h) = try shrink(raw, to: small, edge: (p["edge"] as? NSNumber)?.doubleValue ?? 1280, area: (p["area"] as? NSNumber)?.doubleValue ?? 1_150_000)
		r["file"] = small.path
		r["width"] = w
		r["height"] = h
		r["x"] = Double(area.minX)
		r["y"] = Double(area.minY)
		r["w"] = Double(area.width)
		r["h"] = Double(area.height)
		return r

	default:
		throw Fail(code: "failed", message: "unknown command \(cmd)")
	}
}

// ---- main ----------------------------------------------------------------------------------------

let app = NSApplication.shared
// No icon in the Dock, and never the active app.
app.setActivationPolicy(.prohibited)
if CommandLine.arguments.contains("--demo") {
	demo = Demo()
	demo!.open()
}

Thread.detachNewThread {
	while let line = readLine(strippingNewline: true) {
		guard let data = line.data(using: .utf8), let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let cmd = msg["cmd"] as? String else { continue }
		let id = msg["id"] ?? NSNull()
		// One at a time, on the main thread: AppKit and the accessibility API both want it.
		DispatchQueue.main.async {
			do {
				var r = try handle(cmd, msg)
				r["id"] = id
				r["ok"] = true
				send(r)
			} catch let f as Fail {
				send(["id": id, "ok": false, "code": f.code, "error": f.message])
			} catch {
				send(["id": id, "ok": false, "code": "failed", "error": error.localizedDescription])
			}
		}
	}
	// pine closed the pipe: nothing is left to do.
	exit(0)
}
app.run()
