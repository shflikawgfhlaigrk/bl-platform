import SwiftUI
import StarIO10
import ExternalAccessory

struct SavedStarPrinter: Codable, Identifiable {
    let interfaceValue: Int
    let identifier: String
    let model: String
    let address: String?
    var id: String { "\(interfaceValue):\(identifier)" }
    var interfaceName: String { InterfaceType(rawValue: interfaceValue)?.description ?? "Unknown" }
    var settings: StarConnectionSettings? {
        guard let type = InterfaceType(rawValue: interfaceValue), type != .unknown else { return nil }
        return StarConnectionSettings(interfaceType: type, identifier: identifier)
    }
    init(_ printer: StarPrinter) {
        interfaceValue = printer.connectionSettings.interfaceType.rawValue
        identifier = printer.connectionSettings.identifier
        model = printer.information.map { String(describing: $0.model) } ?? "Star printer"
        address = printer.information?.detail.lan.ipAddress
    }

    init(networkAddress: String) {
        interfaceValue = InterfaceType.lan.rawValue
        identifier = networkAddress
        model = "Star network printer"
        address = networkAddress
    }
}

@MainActor
final class StarReceiptPrinter: ObservableObject, StarDeviceDiscoveryManagerDelegate {
    static let shared = StarReceiptPrinter()
    @Published private(set) var selected: SavedStarPrinter?
    @Published private(set) var preparationPrinters: [PrinterRole: SavedStarPrinter] = [:]
    @Published private(set) var automaticRoles: Set<PrinterRole> = []
    @Published private(set) var discovered: [SavedStarPrinter] = []
    @Published private(set) var discovering = false
    @Published private(set) var busy = false
    @Published private(set) var message = ""
    private let preference = "oneclub.starReceiptPrinter"
    private var discovery: (any StarDeviceDiscoveryManager)?
    private var discoveryInterface = InterfaceType.lan
    let journal: PrintJournal

    private init() {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        journal = PrintJournal(file: directory.appendingPathComponent("BarOne/print-history.json"))
        StarIO10DiagInfoUpload.shared.isEnabled = false
        if let data = UserDefaults.standard.data(forKey: preference) {
            selected = try? JSONDecoder().decode(SavedStarPrinter.self, from: data)
        }
        for role in [PrinterRole.bar, .kitchen] {
            if let data = UserDefaults.standard.data(forKey: preference + "." + role.rawValue),
               let saved = try? JSONDecoder().decode(SavedStarPrinter.self, from: data) { preparationPrinters[role] = saved }
        }
        automaticRoles = Set((UserDefaults.standard.stringArray(forKey: preference + ".automatic") ?? [])
            .compactMap(PrinterRole.init(rawValue:)).filter { $0 != .receipt })
    }

    func printer(for role: PrinterRole) -> SavedStarPrinter? { role == .receipt ? selected : preparationPrinters[role] }
    func setAutomatic(_ enabled: Bool, role: PrinterRole) {
        guard role != .receipt else { return }
        if enabled, printer(for: role) != nil { automaticRoles.insert(role) } else { automaticRoles.remove(role) }
        UserDefaults.standard.set(automaticRoles.map(\.rawValue), forKey: preference + ".automatic")
    }

    func discover(interfaceType: InterfaceType = .lan) {
        guard !busy, !discovering else { return }
        discoveryInterface = interfaceType
        discovered = []; message = "Searching for Star printers…"; discovering = true
        do {
            discovery = try StarDeviceDiscoveryManagerFactory.create(interfaceTypes: [interfaceType])
            discovery?.discoveryTime = 6000
            discovery?.delegate = self
            try discovery?.startDiscovery()
        } catch {
            discovering = false
            message = error.localizedDescription
        }
    }

    func stopDiscovery() {
        discovery?.stopDiscovery()
        discovery?.delegate = nil
        discovery = nil
        discovering = false
    }

    func pairBluetooth() {
        guard !busy else { return }
        stopDiscovery()
        message = "Choose the Star printer in the Bluetooth accessory picker."
        // Venues can rename their printer; discover accessory names without
        // filtering, then verify the selected hardware through StarIO10.
        EAAccessoryManager.shared().showBluetoothAccessoryPicker(withNameFilter: nil) { error in
            Task { @MainActor in
                if let error { self.message = error.localizedDescription }
                else { self.discover(interfaceType: .bluetooth) }
            }
        }
    }

    nonisolated func manager(_ manager: any StarDeviceDiscoveryManager, didFind printer: StarPrinter) {
        let found = SavedStarPrinter(printer)
        Task { @MainActor in
            guard self.discovering else { return }
            if !self.discovered.contains(where: { $0.id == found.id }) { self.discovered.append(found) }
        }
    }

    nonisolated func managerDidFinishDiscovery(_ manager: any StarDeviceDiscoveryManager) {
        Task { @MainActor in
            self.discovering = false
            if !self.discovered.isEmpty {
                self.message = "Select the receipt printer to verify and save its connection."
            } else {
                switch self.discoveryInterface {
                case .lan:
                    self.message = "No Star printer found. Check its power and network cable or Wi-Fi. This iPad and printer must use the same network."
                case .bluetooth:
                    self.message = "No Star printer found. Power on a Bluetooth-capable Star printer and pair it with this iPad."
                case .usb:
                    self.message = "No Star printer found. Check its power and the compatible USB connection to this iPad."
                default:
                    self.message = "No Star printer found. Choose the printer’s connection type."
                }
            }
        }
    }

    func choose(_ candidate: SavedStarPrinter, role: PrinterRole = .receipt) async {
        guard !busy else { return }
        stopDiscovery()
        busy = true; defer { busy = false }
        do {
            let verified = try await communicate(candidate, text: nil)
            UserDefaults.standard.set(try JSONEncoder().encode(verified), forKey: role == .receipt ? preference : preference + "." + role.rawValue)
            if role == .receipt { selected = verified } else { preparationPrinters[role] = verified }
            message = "\(verified.model) is connected and ready."
        } catch { message = error.localizedDescription }
    }

    func connectNetworkAddress(_ input: String, role: PrinterRole = .receipt) async {
        let parts = input.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { part -> UInt8? in
            guard !part.isEmpty, part.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            return UInt8(part)
        }
        guard parts.count == 4, octets.count == 4 else {
            message = "Enter the printer’s IPv4 address, such as 10.1.10.100."
            return
        }
        await choose(SavedStarPrinter(networkAddress: octets.map(String.init).joined(separator: ".")), role: role)
    }

    func forget(role: PrinterRole = .receipt) {
        guard !busy else { return }
        if role == .receipt { selected = nil } else { preparationPrinters.removeValue(forKey: role) }
        UserDefaults.standard.removeObject(forKey: role == .receipt ? preference : preference + "." + role.rawValue)
        setAutomatic(false, role: role)
        message = "Printer selection cleared for \(role.title.lowercased())."
    }

    func submit(_ request: PrintRequest) async throws -> [String: String] {
        guard !busy else { throw failure("The printer is handling another request.") }
        guard let target = printer(for: request.role) else { throw failure("Choose a printer for \(request.role.title.lowercased()) first.") }
        if request.automatic, !automaticRoles.contains(request.role) { throw failure("Automatic printing is off for this station.") }
        let record = try journal.prepare(request)
        if record.status == .submitted { return ["status": "alreadySubmitted", "message": "This document was already sent. Choose another copy to reprint."] }
        if [.sending, .unknown].contains(record.status) { return ["status": "unknown", "message": "Printing was not confirmed. Check the paper before requesting another copy."] }
        stopDiscovery()
        busy = true; defer { busy = false }
        var sending = false
        do {
            _ = try await communicate(target, text: (request.reprint ? "REPRINT / ADDITIONAL COPY\n\n" : "") + request.text, willPrint: {
                try self.journal.set(request, status: .sending, detail: "Waiting for printer acknowledgement.")
                sending = true
            })
            try journal.set(request, status: .submitted, detail: "Printer acknowledged the print request.")
            message = "Sent to \(target.model)."
            return ["status": "submitted", "message": message]
        } catch {
            let detail = sending ? "Printing was not confirmed. Check the paper before printing again." : "Nothing was sent. \(error.localizedDescription)"
            try? journal.set(request, status: sending ? .unknown : .failed, detail: detail)
            message = detail
            if sending { return ["status": "unknown", "message": message] }
            throw failure(message)
        }
    }

    func printReceipt(_ text: String) async throws {
        _ = try await submit(PrintRequest(id: UUID().uuidString, documentID: UUID().uuidString,
            origin: UserDefaults.standard.string(forKey: "oneclub.serverOrigin") ?? "", role: .receipt,
            text: text, automatic: false, reprint: false))
    }

    func testReceipt(role: PrinterRole = .receipt) async {
        let text = "BAR ONE\nPRINTER CONNECTION TEST\n\n\(Date().formatted())\n\nNo sale or payment was made.\n"
        do {
            _ = try await submit(PrintRequest(id: UUID().uuidString, documentID: UUID().uuidString,
                origin: UserDefaults.standard.string(forKey: "oneclub.serverOrigin") ?? "", role: role,
                text: text, automatic: false, reprint: false))
        } catch { message = error.localizedDescription }
    }

    private func communicate(_ target: SavedStarPrinter, text: String?, willPrint: (() throws -> Void)? = nil) async throws -> SavedStarPrinter {
        guard let settings = target.settings else { throw failure("Choose a supported Star printer connection.") }
        // Finish layout before opening the printer: no partial receipt on a
        // rendering failure. Images also support the graphics-only TSP143IIILAN.
        var command: String?
        if let text {
            let safeText = String(String.UnicodeScalarView(text.unicodeScalars.filter {
                $0.value == 10 || ($0.value >= 32 && $0.value != 127)
            }))
            let output = StarXpandCommand.PrinterBuilder()
            for page in try ReceiptRasterizer.pages(for: safeText + "\n") {
                _ = output.actionPrintImage(StarXpandCommand.Printer.ImageParameter(
                    image: page.image, width: ReceiptRasterizer.width))
            }
            _ = output.actionCut(.partial)
            let builder = StarXpandCommand.StarXpandCommandBuilder()
            _ = builder.addDocument(StarXpandCommand.DocumentBuilder().addPrinter(output))
            command = builder.getCommands()
        }
        let printer = StarPrinter(settings)
        do {
            try await printer.open()
            let status = try await printer.getStatus()
            if status.paperEmpty { throw failure("Load receipt paper in the Star printer.") }
            if status.coverOpen { throw failure("Close the Star printer cover.") }
            if status.hasError { throw failure("The Star printer reports an error. Check its status lights.") }
            if let command { try willPrint?(); try await printer.print(command: command) }
            let verified = SavedStarPrinter(printer)
            await printer.close()
            return verified
        } catch {
            await printer.close()
            throw error
        }
    }

    private func failure(_ description: String) -> NSError {
        NSError(domain: "BarOneReceiptPrinter", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }
}

struct StarReceiptPrinterView: View {
    @ObservedObject var printer = StarReceiptPrinter.shared
    @ObservedObject private var journal = StarReceiptPrinter.shared.journal
    @Environment(\.dismiss) private var dismiss
    @State private var connection = InterfaceType.lan.rawValue
    @State private var networkAddress = ""
    @State private var role = PrinterRole.receipt
    var body: some View {
        NavigationStack {
            List {
                Section("Receipt printer") {
                    Picker("Printer use", selection: $role) {
                        ForEach(PrinterRole.allCases) { role in Text(role.title).tag(role) }
                    }.disabled(printer.busy || printer.discovering)
                    if let selected = printer.printer(for: role) {
                        Text(selected.model).font(.headline)
                        Text("\(selected.interfaceName) · \(selected.address ?? selected.identifier)").font(.footnote)
                        Button("Check connection") { Task { await printer.choose(selected, role: role) } }.disabled(printer.busy)
                        Button("Print test receipt") { Task { await printer.testReceipt(role: role) } }.disabled(printer.busy)
                        Button("Forget printer", role: .destructive) { printer.forget(role: role) }.disabled(printer.busy)
                    } else {
                        Text("Choose the bar’s Star receipt printer. Its connection will be saved on this iPad.")
                    }
                    if role != .receipt {
                        Toggle("Print queued tickets automatically", isOn: Binding(
                            get: { printer.automaticRoles.contains(role) },
                            set: { printer.setAutomatic($0, role: role) }))
                            .disabled(printer.printer(for: role) == nil || printer.busy)
                        Text("When enabled, queued tickets print while this iPad’s service screen is open. Uncertain jobs require paper review before another copy.")
                            .font(.footnote)
                    }
                }
                Section("Find Star printers") {
                    Picker("Printer connection", selection: $connection) {
                        Text("Network / Wi-Fi").tag(InterfaceType.lan.rawValue)
                        Text("Bluetooth").tag(InterfaceType.bluetooth.rawValue)
                        Text("USB").tag(InterfaceType.usb.rawValue)
                    }.disabled(printer.discovering || printer.busy)
                    if connection == InterfaceType.bluetooth.rawValue {
                        Button("Pair Bluetooth printer") { printer.pairBluetooth() }.disabled(printer.busy)
                    }
                    Button(printer.discovering ? "Searching…" : "Find printers") {
                        printer.discover(interfaceType: InterfaceType(rawValue: connection) ?? .lan)
                    }
                        .disabled(printer.discovering || printer.busy)
                    ForEach(printer.discovered) { found in
                        Button { Task { await printer.choose(found, role: role) } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(found.model)
                                Text("\(found.interfaceName) · \(found.address ?? found.identifier)").font(.footnote)
                            }
                        }.disabled(printer.busy)
                    }
                    if connection == InterfaceType.lan.rawValue {
                        TextField("Printer IP address", text: $networkAddress)
                            .keyboardType(.numbersAndPunctuation)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("printer-network-address")
                            .disabled(printer.busy || printer.discovering)
                        Button("Connect by IP") {
                            Task { await printer.connectNetworkAddress(networkAddress, role: role) }
                        }.disabled(printer.busy || printer.discovering || networkAddress.isEmpty)
                        Text("Use the IP address on the printer’s network test sheet if it does not appear above.")
                            .font(.footnote)
                    }
                }
                if !printer.message.isEmpty { Section { Text(printer.message).accessibilityIdentifier("printer-discovery-status") } }
                if !journal.records.isEmpty {
                    Section("Recent print requests") {
                        ForEach(journal.records.suffix(20).reversed()) { record in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(record.role.title) · \(record.status.rawValue)").font(.headline)
                                Text(record.documentID).font(.caption)
                                Text(record.detail).font(.footnote)
                            }
                        }
                    }
                }
                Section {
                    Text("LAN and Wi-Fi printers use the same network as this iPad. Bluetooth and USB depend on the printer’s model and cable.")
                }
            }
            .navigationTitle("Receipt printer")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onDisappear { printer.stopDiscovery() }
        }
    }
}
