// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PDFPluginWorker",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "PluginWorkerCore", targets: ["PluginWorkerCore"]),
        .executable(name: "PDFPluginSupervisor", targets: ["PDFPluginSupervisor"]),
        .executable(name: "PDFPluginWorker", targets: ["PDFPluginWorker"]),
    ],
    targets: [
        .target(name: "PluginWorkerCore", linkerSettings: [
            .linkedFramework("Security"), .linkedFramework("JavaScriptCore"),
        ]),
        .executableTarget(name: "PDFPluginSupervisor", dependencies: ["PluginWorkerCore"]),
        .executableTarget(name: "PDFPluginWorker", dependencies: ["PluginWorkerCore"]),
        .testTarget(name: "PluginWorkerCoreTests", dependencies: ["PluginWorkerCore"]),
    ]
)
